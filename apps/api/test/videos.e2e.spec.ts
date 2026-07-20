import multipart from '@fastify/multipart';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Environment } from '../src/config/env';
import { OBJECT_STORAGE, type ObjectStorage } from '../src/storage/storage.port';
import { UsageService } from '../src/usage/usage.service';
import { VIDEO_REPOSITORY, type UploadWithVideo, type VideoRepository } from '../src/videos/video.repository';
import { VideoUploadService } from '../src/videos/video-upload.service';
import { VideoImportService } from '../src/videos/video-import.service';
import type { CompleteUploadInput, CreateUploadInput, VideoRecord } from '../src/videos/video.types';
import { VideosController } from '../src/videos/videos.controller';
import { DirectUploadService } from '../src/videos/direct-upload.service';

class TestRepository implements VideoRepository {
  videos = new Map<string, VideoRecord>();
  keys = new Map<string, { id: string; videoId: string }>();

  async findByIdempotencyKey(key: string): Promise<UploadWithVideo | null> {
    const attempt = this.keys.get(key);
    return attempt ? { id: attempt.id, video: this.videos.get(attempt.videoId)! } : null;
  }

  async findById(id: string): Promise<VideoRecord | null> {
    return this.videos.get(id) ?? null;
  }

  async updateTitle(id: string, _workspaceId: string, title: string): Promise<VideoRecord | null> {
    const video = this.videos.get(id);
    if (!video) return null;
    const updated = { ...video, title, updatedAt: new Date() };
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
    this.keys.set(input.idempotencyKey, { id: input.attemptId, videoId: input.videoId });
    return video;
  }

  async markUploaded(videoId: string, _attemptId: string, input: CompleteUploadInput): Promise<VideoRecord> {
    const video: VideoRecord = {
      ...this.videos.get(videoId)!,
      status: 'UPLOADED',
      sizeBytes: input.sizeBytes,
      checksumSha256: input.checksumSha256 ?? null,
      storageEtag: input.storageEtag ?? null,
      updatedAt: new Date(),
    };
    this.videos.set(videoId, video);
    return video;
  }

  async markFailed(videoId: string, _attemptId: string, code: string): Promise<void> {
    const video = this.videos.get(videoId)!;
    this.videos.set(videoId, { ...video, status: 'FAILED', failureCode: code });
  }
}

class TestStorage implements ObjectStorage {
  async ready(): Promise<boolean> { return true; }
  async createMultipart(): Promise<string> { return 'upload'; }
  async multipartPartUrl(): Promise<string> { return 'https://storage.test/part'; }
  async completeMultipart(): Promise<{ etag: string }> { return { etag: 'etag' }; }
  async abortMultipart(): Promise<void> {}
  async metadata(): Promise<{ bytes: bigint; contentType: string }> { return { bytes: 1n, contentType: 'video/mp4' }; }
  async upload(_key: string, body: NodeJS.ReadableStream): Promise<{ etag: string }> {
    for await (const _chunk of body) {
      // Consuming the iterable proves the production service streams through the HTTP parser.
    }
    return { etag: 'test-etag' };
  }
  async delete(): Promise<void> {}
  async deletePrefix(): Promise<number> { return 0; }
  async downloadUrl(key: string): Promise<string> {
    return `https://storage.test/${key}`;
  }
}

function multipartBody(filename: string, mimeType: string, bytes: Buffer, boundary: string): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`),
    Buffer.from(`Content-Type: ${mimeType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

describe('videos HTTP API', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [VideosController],
      providers: [
        VideoUploadService,
        { provide: UsageService, useValue: { assertCanUpload: async () => ({}) } },
        { provide: VideoImportService, useValue: { import: async () => ({}) } },
        { provide: DirectUploadService, useValue: {} },
        { provide: VIDEO_REPOSITORY, useClass: TestRepository },
        { provide: OBJECT_STORAGE, useClass: TestStorage },
        {
          provide: ConfigService,
          useValue: new ConfigService<Environment, true>({
            S3_BUCKET: 'test-bucket',
            UPLOAD_MAX_BYTES: 1024,
            UPLOAD_MODE: 'stream',
          } as Environment),
        },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ bodyLimit: 4096 }));
    await app.register(multipart, { limits: { files: 1, fileSize: 1024 } });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => app?.close());

  it('uploads and retrieves a video end to end through HTTP', async () => {
    const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from('payload')]);
    const boundary = 'clipbr-boundary';
    const response = await app.inject({
      method: 'POST',
      url: '/videos/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'idempotency-key': 'e2e-request-1234',
      },
      payload: multipartBody('episode.mp4', 'video/mp4', bytes, boundary),
    });
    expect(response.statusCode).toBe(201);
    const uploaded = response.json<VideoRecord & { sizeBytes: string }>();
    expect(uploaded).toMatchObject({ status: 'UPLOADED', container: 'mp4', sizeBytes: String(bytes.length) });
    expect(response.headers.location).toBe(`/videos/${uploaded.id}`);

    const status = await app.inject({ method: 'GET', url: `/videos/${uploaded.id}` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ id: uploaded.id, status: 'UPLOADED', title: 'episode' });
  });

  it('rejects non-multipart and spoofed video content', async () => {
    const plain = await app.inject({
      method: 'POST',
      url: '/videos/upload',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e-request-plain' },
      payload: '{}',
    });
    expect(plain.statusCode).toBe(400);

    const boundary = 'spoof-boundary';
    const spoofed = await app.inject({
      method: 'POST',
      url: '/videos/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'idempotency-key': 'e2e-request-spoof',
      },
      payload: multipartBody('renamed.mp4', 'video/mp4', Buffer.from('not actually a video'), boundary),
    });
    expect(spoofed.statusCode).toBe(415);
  });

  it('returns 413 when the multipart parser truncates one byte over the limit', async () => {
    const header = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')]);
    const bytes = Buffer.concat([header, Buffer.alloc(1025 - header.length)]);
    const boundary = 'oversized-boundary';
    const response = await app.inject({
      method: 'POST',
      url: '/videos/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'idempotency-key': 'e2e-request-oversized',
      },
      payload: multipartBody('too-large.mp4', 'video/mp4', bytes, boundary),
    });
    expect(response.statusCode).toBe(413);
  });

  it('rejects a malformed video id before querying PostgreSQL', async () => {
    const response = await app.inject({ method: 'GET', url: '/videos/not-a-uuid' });
    expect(response.statusCode).toBe(400);
  });
});
