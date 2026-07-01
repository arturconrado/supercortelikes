import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/env';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/storage.port';
import { VideoResponseDto } from './video-response.dto';
import { VIDEO_REPOSITORY, type VideoRepository } from './video.repository';
import { safeOriginalFilename, UploadMetricsTransform, validateAndReplayVideo, VideoTooLargeError } from './video-stream';
import type { UploadFile } from './video.types';
import type { AuthenticatedUser } from '../auth/auth.types';
import { UsageService } from '../usage/usage.service';

@Injectable()
export class VideoUploadService {
  private readonly logger = new Logger(VideoUploadService.name);
  private readonly bucket: string;
  private readonly maxBytes: bigint;

  constructor(
    @Inject(VIDEO_REPOSITORY) private readonly videos: VideoRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    config: ConfigService<Environment, true>,
    private readonly usage: UsageService,
  ) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.maxBytes = BigInt(config.get('UPLOAD_MAX_BYTES', { infer: true }));
  }

  async upload(
    file: UploadFile,
    idempotencyKey: string,
    actor?: AuthenticatedUser,
    projectId?: string,
  ): Promise<VideoResponseDto> {
    this.assertIdempotencyKey(idempotencyKey);
    const previous = await this.videos.findByIdempotencyKey(idempotencyKey);
    if (previous) {
      file.stream.resume();
      if (previous.video.status === 'UPLOADED') return VideoResponseDto.from(previous.video, true);
      throw new ConflictException(
        previous.video.status === 'UPLOADING'
          ? 'An upload with this idempotency key is already in progress'
          : 'The previous upload with this idempotency key failed; use a new key',
      );
    }

    const originalFilename = safeOriginalFilename(file.filename);
    const prepared = await validateAndReplayVideo(file.stream, originalFilename, file.mimetype);
    if (actor) await this.usage.assertCanUpload(actor, 0n);
    const videoId = randomUUID();
    const attemptId = randomUUID();
    const storageKey = `videos/${videoId}/source.${prepared.container}`;
    await this.videos.createUpload({
      videoId,
      attemptId,
      idempotencyKey,
      originalFilename,
      title: displayTitleFromFilename(originalFilename),
      storageKey,
      storageBucket: this.bucket,
      mimeType: prepared.mimeType,
      container: prepared.container,
      workspaceId: actor?.workspaceId,
      ownerId: actor?.userId,
      projectId,
    });

    const metrics = new UploadMetricsTransform(this.maxBytes);
    prepared.stream.once('error', (error) => metrics.destroy(error));
    prepared.stream.pipe(metrics);
    try {
      const stored = await this.storage.upload(storageKey, metrics, prepared.mimeType);
      if ((file.stream as typeof file.stream & { truncated?: boolean }).truncated) {
        throw new VideoTooLargeError(Number(this.maxBytes));
      }
      const completed = await this.videos.markUploaded(videoId, attemptId, {
        sizeBytes: metrics.bytes(),
        checksumSha256: metrics.digest(),
        storageEtag: stored.etag,
      });
      return VideoResponseDto.from(completed);
    } catch (error) {
      prepared.stream.destroy();
      metrics.destroy();
      const failure = this.publicFailure(error);
      await this.tryMarkFailed(videoId, attemptId, failure.code, failure.message, metrics.bytes());
      if (failure.removeObject) await this.tryDelete(storageKey);
      throw failure.exception;
    }
  }

  async get(videoId: string, workspaceId?: string): Promise<VideoResponseDto> {
    const video = await this.videos.findById(videoId, workspaceId);
    if (!video) throw new NotFoundException('Video not found');
    const response = VideoResponseDto.from(video);
    response.playbackUrl = await this.storage.downloadUrl(video.storageKey, 900);
    if (video.thumbnailKey) response.thumbnailUrl = await this.storage.downloadUrl(video.thumbnailKey, 900);
    return response;
  }

  async updateTitle(videoId: string, workspaceId: string, title: string): Promise<VideoResponseDto> {
    const normalized = title.trim().replace(/\s+/g, ' ');
    if (normalized.length < 1 || normalized.length > 180) {
      throw new BadRequestException('Video title must contain 1-180 characters');
    }
    const video = await this.videos.updateTitle(videoId, workspaceId, normalized);
    if (!video) throw new NotFoundException('Video not found');
    const response = VideoResponseDto.from(video);
    response.playbackUrl = await this.storage.downloadUrl(video.storageKey, 900);
    if (video.thumbnailKey) response.thumbnailUrl = await this.storage.downloadUrl(video.thumbnailKey, 900);
    return response;
  }

  private assertIdempotencyKey(key: string): void {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw new BadRequestException('Idempotency-Key must contain 8-128 safe ASCII characters');
    }
  }

  private publicFailure(error: unknown): {
    code: string;
    message: string;
    exception: HttpException;
    removeObject: boolean;
  } {
    if (error instanceof VideoTooLargeError || this.errorCode(error) === 'FST_REQ_FILE_TOO_LARGE') {
      return {
        code: 'VIDEO_TOO_LARGE',
        message: `The video exceeds the ${this.maxBytes.toString()} byte limit`,
        exception: new PayloadTooLargeException('The video exceeds the 5 GiB limit'),
        removeObject: true,
      };
    }
    if (error instanceof UnsupportedMediaTypeException) {
      return { code: 'UNSUPPORTED_VIDEO', message: error.message, exception: error, removeObject: false };
    }
    if (error instanceof HttpException) {
      return { code: 'UPLOAD_REJECTED', message: error.message, exception: error, removeObject: false };
    }
    this.logger.error(`Video upload failed (${this.errorCode(error) ?? 'unknown error'})`);
    return {
      code: 'STORAGE_ERROR',
      message: 'The object storage did not complete the upload',
      exception: new ServiceUnavailableException('Video storage is temporarily unavailable'),
      removeObject: true,
    };
  }

  private errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
  }

  private async tryMarkFailed(
    videoId: string,
    attemptId: string,
    code: string,
    message: string,
    bytesReceived: bigint,
  ): Promise<void> {
    try {
      await this.videos.markFailed(videoId, attemptId, code, message, bytesReceived);
    } catch {
      this.logger.error(`Could not persist failed state for video ${videoId}`);
    }
  }

  private async tryDelete(storageKey: string): Promise<void> {
    try {
      await this.storage.delete(storageKey);
    } catch {
      this.logger.error(`Could not compensate stored object for key ${storageKey}`);
    }
  }
}

function displayTitleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').trim() || filename;
}
