import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../config/env';
import type { ObjectStorage } from '../storage/storage.port';
import { DirectUploadService } from './direct-upload.service';

const actor = { userId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', email: 'owner@clipbr.test' };
const videoId = '33333333-3333-4333-8333-333333333333';

function fixture() {
  const video = {
    id: videoId,
    workspaceId: actor.workspaceId,
    storageKey: `videos/${videoId}/source.mp4`,
    storageBucket: 'videos-test',
    originalFilename: 'demo.mp4',
    mimeType: 'video/mp4',
    container: 'mp4',
    status: 'UPLOADING',
    sizeBytes: null,
    checksumSha256: null,
    storageEtag: null,
    failureCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const attempt = {
    id: '44444444-4444-4444-8444-444444444444',
    videoId,
    providerUploadId: 'provider-upload',
    expectedSizeBytes: 10n,
    expectedMimeType: 'video/mp4',
    expiresAt: new Date(Date.now() + 60_000),
    status: 'STARTED',
    video,
  };
  const tx = {
    video: { create: vi.fn().mockResolvedValue(video) },
    uploadAttempt: { create: vi.fn().mockResolvedValue(attempt) },
  };
  const prisma = {
    uploadAttempt: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(attempt),
      update: vi.fn().mockResolvedValue(attempt),
    },
    project: { findFirst: vi.fn().mockResolvedValue({ id: 'project' }) },
    video: {
      findFirst: vi.fn().mockResolvedValue({ ...video, clips: [] }),
      update: vi.fn().mockResolvedValue(video),
      delete: vi.fn().mockResolvedValue(video),
    },
    $transaction: vi.fn(async (input: unknown) => typeof input === 'function' ? input(tx) : Promise.all(input as Promise<unknown>[])),
  };
  const storage: ObjectStorage = {
    ready: vi.fn().mockResolvedValue(true),
    createMultipart: vi.fn().mockResolvedValue('provider-upload'),
    multipartPartUrl: vi.fn().mockImplementation((_key, _upload, part) => Promise.resolve(`https://storage.test/${part}`)),
    completeMultipart: vi.fn().mockResolvedValue({ etag: 'complete-etag' }),
    abortMultipart: vi.fn().mockResolvedValue(undefined),
    metadata: vi.fn().mockResolvedValue({ bytes: 10n, contentType: 'video/mp4', etag: 'head-etag' }),
    upload: vi.fn().mockResolvedValue({ etag: 'legacy' }),
    uploadUrl: vi.fn().mockResolvedValue('https://storage.test/upload'),
    delete: vi.fn().mockResolvedValue(undefined),
    deletePrefix: vi.fn().mockResolvedValue(0),
    downloadUrl: vi.fn().mockResolvedValue('https://storage.test/download'),
  };
  const repository = {
    markUploaded: vi.fn().mockResolvedValue({ ...video, status: 'UPLOADED', sizeBytes: 10n, storageEtag: 'complete-etag' }),
  };
  const config = new ConfigService<Environment, true>({
    S3_BUCKET: 'videos-test',
    UPLOAD_MAX_BYTES: 5_368_709_120,
    UPLOAD_PART_SIZE_BYTES: 8,
    UPLOAD_ALLOWED_MIME_TYPES: ['video/mp4'],
  } as Environment);
  const usage = { assertCanUpload: vi.fn().mockResolvedValue({}) };
  const lifecycle = { remove: vi.fn().mockResolvedValue(undefined) };
  return { service: new DirectUploadService(prisma as never, storage, repository as never, config, usage as never, lifecycle as never), prisma, storage, repository, attempt, video, usage, lifecycle };
}

describe('DirectUploadService', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates a tenant-owned multipart upload and returns its deterministic shape', async () => {
    const { service, prisma, storage, usage } = fixture();
    const session = await service.create({ filename: 'demo.mp4', mimeType: 'video/mp4', sizeBytes: 10 }, 'request-1234', actor);
    expect(session).toMatchObject({ uploadId: 'provider-upload', partSizeBytes: 8, partCount: 2 });
    expect(usage.assertCanUpload).toHaveBeenCalledWith(actor, 10n);
    expect(storage.createMultipart).toHaveBeenCalledWith(expect.stringMatching(/^videos\/.+\/source\.mp4$/), 'video/mp4');
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it('returns the original session for an idempotent retry and hides another tenant', async () => {
    const first = fixture();
    first.prisma.uploadAttempt.findUnique.mockResolvedValue(first.attempt as never);
    await expect(first.service.create({ filename: 'demo.mp4', mimeType: 'video/mp4', sizeBytes: 10 }, 'request-1234', actor))
      .resolves.toMatchObject({ videoId, uploadId: 'provider-upload' });
    await expect(first.service.create(
      { filename: 'demo.mp4', mimeType: 'video/mp4', sizeBytes: 10 },
      'request-1234',
      { ...actor, workspaceId: '55555555-5555-4555-8555-555555555555' },
    )).rejects.toBeInstanceOf(NotFoundException);
  });

  it('signs only valid expected parts and rejects out-of-range parts', async () => {
    const { service } = fixture();
    await expect(service.partUrls(videoId, { uploadId: 'provider-upload', partNumbers: [1, 2] }, actor))
      .resolves.toMatchObject({ expiresInSeconds: 900, parts: [{ partNumber: 1 }, { partNumber: 2 }] });
    await expect(service.partUrls(videoId, { uploadId: 'provider-upload', partNumbers: [3] }, actor))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('completes all parts, verifies object metadata and persists upload completion', async () => {
    const { service, repository } = fixture();
    await expect(service.confirm({
      videoId,
      uploadId: 'provider-upload',
      parts: [{ partNumber: 2, etag: 'two' }, { partNumber: 1, etag: 'one' }],
    }, actor)).resolves.toMatchObject({ id: videoId, status: 'UPLOADED', sizeBytes: '10' });
    expect(repository.markUploaded).toHaveBeenCalledWith(videoId, expect.any(String), { sizeBytes: 10n, storageEtag: 'complete-etag' });
  });

  it('recovers confirmation after storage completed but persistence was interrupted', async () => {
    const { service, storage, repository } = fixture();
    vi.mocked(storage.completeMultipart).mockRejectedValueOnce(new Error('NoSuchUpload'));
    await service.confirm({
      videoId, uploadId: 'provider-upload',
      parts: [{ partNumber: 1, etag: 'one' }, { partNumber: 2, etag: 'two' }],
    }, actor);
    expect(repository.markUploaded).toHaveBeenCalledWith(videoId, expect.any(String), { sizeBytes: 10n, storageEtag: 'head-etag' });
  });

  it('aborts idempotently at storage and records a bounded failure', async () => {
    const { service, storage, prisma } = fixture();
    await service.abort(videoId, actor);
    expect(storage.abortMultipart).toHaveBeenCalledWith(expect.stringContaining(videoId), 'provider-upload');
    expect(prisma.uploadAttempt.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }));
    prisma.uploadAttempt.findFirst.mockResolvedValue({ ...fixture().attempt, status: 'COMPLETED' } as never);
    await expect(service.abort(videoId, actor)).rejects.toBeInstanceOf(ConflictException);
  });

  it('delegates complete video cleanup with tenant ownership', async () => {
    const { service, lifecycle } = fixture();
    await service.remove(videoId, actor);
    expect(lifecycle.remove).toHaveBeenCalledWith(videoId, actor.workspaceId);
  });
});
