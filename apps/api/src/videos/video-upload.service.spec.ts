import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { Environment } from '../config/env';
import type { ObjectStorage } from '../storage/storage.port';
import { VideoUploadService } from './video-upload.service';
import type { UploadWithVideo, VideoRepository } from './video.repository';
import type { CompleteUploadInput, CreateUploadInput, VideoRecord } from './video.types';

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from('payload')]);

class MemoryVideoRepository implements VideoRepository {
  readonly videos = new Map<string, VideoRecord>();
  readonly attempts = new Map<string, { id: string; videoId: string }>();

  async findByIdempotencyKey(key: string): Promise<UploadWithVideo | null> {
    const attempt = this.attempts.get(key);
    return attempt ? { id: attempt.id, video: this.videos.get(attempt.videoId)! } : null;
  }

  async findById(id: string): Promise<VideoRecord | null> {
    return this.videos.get(id) ?? null;
  }

  async updateTitle(id: string, _workspaceId: string, title: string): Promise<VideoRecord | null> {
    const previous = this.videos.get(id);
    if (!previous) return null;
    const updated = { ...previous, title, updatedAt: new Date() };
    this.videos.set(id, updated);
    return updated;
  }

  async createUpload(input: CreateUploadInput): Promise<VideoRecord> {
    const now = new Date();
    const video: VideoRecord = {
      id: input.videoId,
      originalFilename: input.originalFilename,
      title: input.title ?? input.originalFilename,
      storageKey: input.storageKey,
      storageBucket: input.storageBucket,
      mimeType: input.mimeType,
      container: input.container,
      sizeBytes: null,
      checksumSha256: null,
      storageEtag: null,
      status: 'UPLOADING',
      failureCode: null,
      createdAt: now,
      updatedAt: now,
    };
    this.videos.set(video.id, video);
    this.attempts.set(input.idempotencyKey, { id: input.attemptId, videoId: input.videoId });
    return video;
  }

  async markUploaded(videoId: string, _attemptId: string, input: CompleteUploadInput): Promise<VideoRecord> {
    const previous = this.videos.get(videoId)!;
    const video = {
      ...previous,
      status: 'UPLOADED' as const,
      sizeBytes: input.sizeBytes,
      checksumSha256: input.checksumSha256 ?? null,
      storageEtag: input.storageEtag ?? null,
      updatedAt: new Date(),
    };
    this.videos.set(videoId, video);
    return video;
  }

  async markFailed(
    videoId: string,
    _attemptId: string,
    code: string,
    _message: string,
    _bytesReceived: bigint,
  ): Promise<void> {
    const previous = this.videos.get(videoId)!;
    this.videos.set(videoId, { ...previous, status: 'FAILED', failureCode: code, updatedAt: new Date() });
  }
}

class MemoryStorage implements ObjectStorage {
  async ready(): Promise<boolean> { return true; }
  async createMultipart(): Promise<string> { return 'upload'; }
  async multipartPartUrl(): Promise<string> { return 'http://storage/part'; }
  async completeMultipart(): Promise<{ etag: string }> { return { etag: 'etag' }; }
  async abortMultipart(): Promise<void> {}
  async metadata(): Promise<{ bytes: bigint; contentType: string }> { return { bytes: 1n, contentType: 'video/mp4' }; }
  readonly objects = new Map<string, Buffer>();
  fail = false;

  async upload(key: string, body: Readable): Promise<{ etag: string }> {
    if (this.fail) throw Object.assign(new Error('secret endpoint failure'), { code: 'R2_FAILURE' });
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
    this.objects.set(key, Buffer.concat(chunks));
    return { etag: 'etag' };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async downloadUrl(key: string): Promise<string> {
    return `https://storage.test/${key}`;
  }
}

function service(maxBytes = 5_368_709_120): {
  uploads: VideoUploadService;
  repository: MemoryVideoRepository;
  storage: MemoryStorage;
} {
  const repository = new MemoryVideoRepository();
  const storage = new MemoryStorage();
  const config = new ConfigService<Environment, true>({
    S3_BUCKET: 'videos-test',
    UPLOAD_MAX_BYTES: maxBytes,
  } as Environment);
  const usage = { assertCanUpload: async () => ({}) };
  return { uploads: new VideoUploadService(repository, storage, config, usage as never), repository, storage };
}

describe('VideoUploadService', () => {
  it('streams a valid video, persists metadata, and serves its status', async () => {
    const { uploads, repository, storage } = service();
    const response = await uploads.upload(
      { filename: '../../episode.mp4', mimetype: 'video/mp4', stream: Readable.from([mp4]) },
      'request-1234',
    );
    expect(response).toMatchObject({ status: 'UPLOADED', originalFilename: 'episode.mp4', sizeBytes: String(mp4.length) });
    expect(response.checksumSha256).toBe(createHash('sha256').update(mp4).digest('hex'));
    expect(storage.objects.values().next().value).toEqual(mp4);
    expect(repository.videos.get(response.id)?.status).toBe('UPLOADED');
    await expect(uploads.get(response.id)).resolves.toMatchObject({ id: response.id });
  });

  it('updates the display title without changing the original filename', async () => {
    const { uploads } = service();
    const response = await uploads.upload(
      { filename: 'episode.mp4', mimetype: 'video/mp4', stream: Readable.from([mp4]) },
      'request-title',
      { userId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', email: 'ana@clipbr.test' },
    );

    await expect(uploads.updateTitle(response.id, '22222222-2222-4222-8222-222222222222', '  Episódio especial  '))
      .resolves.toMatchObject({ title: 'Episódio especial', originalFilename: 'episode.mp4' });
  });

  it('returns the completed resource for a repeated idempotency key', async () => {
    const { uploads } = service();
    const first = await uploads.upload(
      { filename: 'episode.mp4', mimetype: 'video/mp4', stream: Readable.from([mp4]) },
      'request-5678',
    );
    const repeated = await uploads.upload(
      { filename: 'another.mp4', mimetype: 'video/mp4', stream: Readable.from([mp4]) },
      'request-5678',
    );
    expect(repeated).toMatchObject({ id: first.id, reused: true });
  });

  it('rejects unsafe idempotency keys', async () => {
    const { uploads } = service();
    await expect(
      uploads.upload({ filename: 'x.mp4', mimetype: 'video/mp4', stream: Readable.from([mp4]) }, '../bad'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('records a bounded failure without leaking storage details', async () => {
    const { uploads, repository, storage } = service();
    storage.fail = true;
    await expect(
      uploads.upload(
        { filename: 'episode.mp4', mimetype: 'video/mp4', stream: Readable.from([mp4]) },
        'request-failure',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect([...repository.videos.values()][0]?.failureCode).toBe('STORAGE_ERROR');
  });

  it('enforces the byte limit from the actual stream', async () => {
    const { uploads, repository } = service(mp4.length - 1);
    await expect(
      uploads.upload(
        { filename: 'episode.mp4', mimetype: 'video/mp4', stream: Readable.from([mp4]) },
        'request-too-large',
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect([...repository.videos.values()][0]?.failureCode).toBe('VIDEO_TOO_LARGE');
  });

  it('rejects and removes a stream truncated by the multipart parser', async () => {
    const { uploads, repository, storage } = service();
    const stream = Readable.from([mp4]) as Readable & { truncated: boolean };
    stream.truncated = true;
    await expect(
      uploads.upload({ filename: 'episode.mp4', mimetype: 'video/mp4', stream }, 'request-truncated'),
    ).rejects.toMatchObject({ status: 413 });
    expect(storage.objects.size).toBe(0);
    expect([...repository.videos.values()][0]?.failureCode).toBe('VIDEO_TOO_LARGE');
  });
});
