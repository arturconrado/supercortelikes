import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Environment } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { OBJECT_STORAGE, type MultipartPart, type ObjectStorage } from '../storage/storage.port';
import type { AuthenticatedUser } from '../auth/auth.types';
import { safeOriginalFilename } from './video-stream';
import type { ConfirmUploadDto, PresignedUploadDto, UploadPartsDto } from './direct-upload.dto';
import { VideoResponseDto } from './video-response.dto';
import { VIDEO_REPOSITORY, type VideoRepository } from './video.repository';
import { UsageService } from '../usage/usage.service';
import { normalizeVideoProcessingOptions } from './video-processing-options';

const containerByExtension: Record<string, { container: string; mimeType: string }> = {
  mp4: { container: 'mp4', mimeType: 'video/mp4' },
  mov: { container: 'mov', mimeType: 'video/quicktime' },
  webm: { container: 'webm', mimeType: 'video/webm' },
  mkv: { container: 'mkv', mimeType: 'video/x-matroska' },
  avi: { container: 'avi', mimeType: 'video/x-msvideo' },
};

export interface MultipartSessionResponse {
  videoId: string;
  uploadId: string;
  storageKey: string;
  partSizeBytes: number;
  partCount: number;
  expiresAt: string;
  completed?: boolean;
}

@Injectable()
export class DirectUploadService {
  private readonly bucket: string;
  private readonly maxBytes: bigint;
  private readonly partSize: number;
  private readonly allowedMimeTypes: Set<string>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(VIDEO_REPOSITORY) private readonly videos: VideoRepository,
    config: ConfigService<Environment, true>,
    private readonly usage: UsageService,
  ) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.maxBytes = BigInt(config.get('UPLOAD_MAX_BYTES', { infer: true }));
    this.partSize = config.get('UPLOAD_PART_SIZE_BYTES', { infer: true });
    this.allowedMimeTypes = new Set(config.get('UPLOAD_ALLOWED_MIME_TYPES', { infer: true }));
  }

  async create(input: PresignedUploadDto, idempotencyKey: string, actor: AuthenticatedUser): Promise<MultipartSessionResponse> {
    this.assertIdempotencyKey(idempotencyKey);
    const existing = await this.prisma.uploadAttempt.findUnique({
      where: { idempotencyKey },
      include: { video: true },
    });
    if (existing) {
      if (existing.video.workspaceId !== actor.workspaceId) throw new NotFoundException('Upload not found');
      if (!existing.providerUploadId || !existing.expectedSizeBytes || !existing.expiresAt) {
        throw new ConflictException('Idempotency key belongs to a streamed upload');
      }
      if (existing.status === 'FAILED') throw new ConflictException('Previous upload attempt failed; use a new key');
      return this.session(existing.video.id, existing.providerUploadId, existing.video.storageKey, existing.expectedSizeBytes, existing.expiresAt, existing.status === 'COMPLETED');
    }

    const originalFilename = safeOriginalFilename(input.filename);
    const extension = originalFilename.split('.').at(-1)?.toLowerCase() ?? '';
    const media = containerByExtension[extension];
    if (!media || !this.allowedMimeTypes.has(input.mimeType) || media.mimeType !== input.mimeType) {
      throw new UnsupportedMediaTypeException('Use a valid MP4, MOV, WEBM, MKV, or AVI MIME type and extension');
    }
    const sizeBytes = BigInt(input.sizeBytes);
    if (sizeBytes > this.maxBytes) throw new PayloadTooLargeException('The video exceeds the configured upload limit');
    await this.usage.assertCanUpload(actor, sizeBytes);
    if (input.projectId) {
      const project = await this.prisma.project.findFirst({ where: { id: input.projectId, workspaceId: actor.workspaceId } });
      if (!project) throw new NotFoundException('Project not found');
    }

    const videoId = randomUUID();
    const attemptId = randomUUID();
    const storageKey = `videos/${videoId}/source.${media.container}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const uploadId = await this.storage.createMultipart(storageKey, media.mimeType);
    const processingOptions = normalizeVideoProcessingOptions(input.processingOptions);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.video.create({
          data: {
            id: videoId,
            originalFilename,
            title: displayTitleFromFilename(originalFilename),
            storageKey,
            storageBucket: this.bucket,
            mimeType: media.mimeType,
            container: media.container,
            workspaceId: actor.workspaceId,
            ownerId: actor.userId,
            projectId: input.projectId,
            processingOptions: processingOptions as Prisma.InputJsonObject,
          },
        });
        await tx.uploadAttempt.create({
          data: {
            id: attemptId,
            videoId,
            idempotencyKey,
            providerUploadId: uploadId,
            expectedSizeBytes: sizeBytes,
            expectedMimeType: media.mimeType,
            expiresAt,
          },
        });
      });
    } catch (error) {
      await this.storage.abortMultipart(storageKey, uploadId).catch(() => undefined);
      throw error;
    }
    return this.session(videoId, uploadId, storageKey, sizeBytes, expiresAt);
  }

  async partUrls(videoId: string, input: UploadPartsDto, actor: AuthenticatedUser): Promise<{ expiresInSeconds: number; parts: Array<{ partNumber: number; url: string }> }> {
    const attempt = await this.attempt(videoId, input.uploadId, actor.workspaceId);
    if (attempt.status !== 'STARTED') throw new ConflictException('Upload is not active');
    if (!attempt.expiresAt || attempt.expiresAt <= new Date()) throw new ConflictException('Upload session expired');
    const partCount = this.partCount(attempt.expectedSizeBytes ?? 0n);
    if (input.partNumbers.some((value) => value > partCount)) throw new BadRequestException('Part number exceeds expected part count');
    const parts = await Promise.all(input.partNumbers.map(async (partNumber) => ({
      partNumber,
      url: await this.storage.multipartPartUrl(attempt.video.storageKey, input.uploadId, partNumber, 900),
    })));
    return { expiresInSeconds: 900, parts };
  }

  async confirm(input: ConfirmUploadDto, actor: AuthenticatedUser): Promise<VideoResponseDto> {
    const attempt = await this.attempt(input.videoId, input.uploadId, actor.workspaceId);
    if (attempt.status === 'COMPLETED') return VideoResponseDto.from(attempt.video as never, true);
    if (attempt.status !== 'STARTED') throw new ConflictException('Upload cannot be completed');
    const expectedParts = this.partCount(attempt.expectedSizeBytes ?? 0n);
    const sorted = [...input.parts].sort((left, right) => left.partNumber - right.partNumber);
    if (sorted.length !== expectedParts || sorted.some((part, index) => part.partNumber !== index + 1)) {
      throw new BadRequestException('Every expected multipart part must be supplied exactly once');
    }
    let stored: { etag?: string };
    try {
      stored = await this.storage.completeMultipart(attempt.video.storageKey, input.uploadId, sorted as MultipartPart[]);
    } catch (error) {
      const recovered = await this.storage.metadata(attempt.video.storageKey).catch(() => undefined);
      if (!recovered || recovered.bytes !== attempt.expectedSizeBytes || recovered.contentType !== attempt.expectedMimeType) throw error;
      stored = { etag: recovered.etag };
    }
    const metadata = await this.storage.metadata(attempt.video.storageKey);
    if (metadata.bytes !== attempt.expectedSizeBytes || metadata.contentType !== attempt.expectedMimeType) {
      await this.storage.delete(attempt.video.storageKey).catch(() => undefined);
      await this.failAttempt(attempt.id, attempt.video.id, 'UPLOAD_METADATA_MISMATCH');
      throw new BadRequestException('Uploaded object metadata does not match the requested upload');
    }
    const video = await this.videos.markUploaded(attempt.video.id, attempt.id, {
      sizeBytes: metadata.bytes,
      storageEtag: stored.etag ?? metadata.etag,
    });
    return VideoResponseDto.from(video);
  }

  async abort(videoId: string, actor: AuthenticatedUser): Promise<void> {
    const attempt = await this.prisma.uploadAttempt.findFirst({
      where: { videoId, video: { workspaceId: actor.workspaceId } },
      include: { video: true },
      orderBy: { startedAt: 'desc' },
    });
    if (!attempt) throw new NotFoundException('Upload not found');
    if (attempt.status === 'COMPLETED') throw new ConflictException('Completed upload cannot be aborted');
    if (attempt.providerUploadId) {
      await this.storage.abortMultipart(attempt.video.storageKey, attempt.providerUploadId).catch(() => undefined);
    }
    await this.failAttempt(attempt.id, attempt.video.id, 'UPLOAD_ABORTED');
  }

  async remove(videoId: string, actor: AuthenticatedUser): Promise<void> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, workspaceId: actor.workspaceId },
      include: { uploads: true, clips: { include: { exports: true, captions: true } } },
    });
    if (!video) throw new NotFoundException('Video not found');
    await Promise.all(video.uploads
      .filter((attempt) => attempt.status === 'STARTED' && attempt.providerUploadId)
      .map((attempt) => this.storage.abortMultipart(video.storageKey, attempt.providerUploadId!).catch(() => undefined)));
    const keys = new Set<string>([video.storageKey]);
    for (const clip of video.clips) {
      for (const item of clip.exports) if (item.storageKey) keys.add(item.storageKey);
      for (const caption of clip.captions) {
        if (caption.srtKey) keys.add(caption.srtKey);
        if (caption.assKey) keys.add(caption.assKey);
      }
    }
    await Promise.all([...keys].map((key) => this.storage.delete(key)));
    await this.prisma.video.delete({ where: { id: video.id } });
  }

  private async attempt(videoId: string, uploadId: string, workspaceId: string) {
    const attempt = await this.prisma.uploadAttempt.findFirst({
      where: { videoId, providerUploadId: uploadId, video: { workspaceId } },
      include: { video: true },
    });
    if (!attempt) throw new NotFoundException('Upload session not found');
    return attempt;
  }

  private session(videoId: string, uploadId: string, storageKey: string, sizeBytes: bigint, expiresAt: Date, completed = false): MultipartSessionResponse {
    return {
      videoId, uploadId, storageKey, partSizeBytes: this.partSize, partCount: this.partCount(sizeBytes),
      expiresAt: expiresAt.toISOString(), ...(completed ? { completed: true } : {}),
    };
  }

  private partCount(sizeBytes: bigint): number {
    return Math.ceil(Number(sizeBytes) / this.partSize);
  }

  private assertIdempotencyKey(key: string): void {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw new BadRequestException('Idempotency-Key must contain 8-128 safe ASCII characters');
    }
  }

  private async failAttempt(attemptId: string, videoId: string, code: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.uploadAttempt.update({
        where: { id: attemptId },
        data: { status: 'FAILED', failureCode: code, completedAt: new Date() },
      }),
      this.prisma.video.update({
        where: { id: videoId },
        data: { status: 'FAILED', failureCode: code, failureMessage: 'Direct upload did not complete' },
      }),
    ]);
  }
}

function displayTitleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').trim() || filename;
}
