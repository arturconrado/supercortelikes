import { describe, expect, it, vi } from 'vitest';
import { OrphanUploadCleanupService } from './orphan-upload-cleanup.service';

describe('OrphanUploadCleanupService', () => {
  it('claims an expired upload before aborting storage and finalizes the failure code', async () => {
    const tx = {
      uploadAttempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      video: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      uploadAttempt: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'attempt-1', videoId: 'video-1', status: 'STARTED',
          providerUploadId: 'multipart-1', video: { id: 'video-1', storageKey: 'videos/video-1/source.mp4' },
        }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)),
    };
    const storage = { abortMultipart: vi.fn().mockResolvedValue(undefined) };
    const service = new OrphanUploadCleanupService(prisma as never, storage as never);

    await expect(service.cleanupOnce(new Date('2026-08-04T12:00:00Z'))).resolves.toBe(1);
    expect(tx.uploadAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'FAILED', failureCode: 'UPLOAD_EXPIRED_STORAGE_PENDING' }),
    }));
    expect(storage.abortMultipart).toHaveBeenCalledWith('videos/video-1/source.mp4', 'multipart-1');
    expect(prisma.uploadAttempt.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { failureCode: 'UPLOAD_SESSION_EXPIRED' },
    }));
  });

  it('skips an expired upload when another worker already claimed it', async () => {
    const tx = {
      uploadAttempt: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      video: { updateMany: vi.fn() },
    };
    const prisma = {
      uploadAttempt: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'attempt-claimed', videoId: 'video-claimed', status: 'STARTED',
          providerUploadId: 'multipart-claimed', video: { id: 'video-claimed', storageKey: 'videos/video-claimed/source.mp4' },
        }]),
        updateMany: vi.fn(),
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<boolean>) => callback(tx)),
    };
    const storage = { abortMultipart: vi.fn() };
    const service = new OrphanUploadCleanupService(prisma as never, storage as never);

    await expect(service.cleanupOnce()).resolves.toBe(0);
    expect(tx.video.updateMany).not.toHaveBeenCalled();
    expect(storage.abortMultipart).not.toHaveBeenCalled();
    expect(prisma.uploadAttempt.updateMany).not.toHaveBeenCalled();
  });

  it('finalizes a pending attempt without a provider upload id', async () => {
    const prisma = {
      uploadAttempt: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'attempt-pending', videoId: 'video-pending', status: 'FAILED',
          providerUploadId: null, video: { id: 'video-pending', storageKey: 'videos/video-pending/source.mp4' },
        }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const storage = { abortMultipart: vi.fn() };
    const service = new OrphanUploadCleanupService(prisma as never, storage as never);

    await expect(service.cleanupOnce()).resolves.toBe(1);
    expect(storage.abortMultipart).not.toHaveBeenCalled();
    expect(prisma.uploadAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { failureCode: 'UPLOAD_SESSION_EXPIRED' },
    }));
  });

  it.each([
    { name: 'NoSuchUpload' },
    { Code: 'NoSuchUpload' },
    { code: 'NoSuchUpload' },
    { $metadata: { httpStatusCode: 404 } },
  ])('treats an already missing multipart upload as cleaned: %o', async (missingError) => {
    const prisma = {
      uploadAttempt: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'attempt-missing', videoId: 'video-missing', status: 'FAILED',
          providerUploadId: 'multipart-missing', video: { id: 'video-missing', storageKey: 'videos/video-missing/source.mp4' },
        }]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const storage = { abortMultipart: vi.fn().mockRejectedValue(missingError) };
    const service = new OrphanUploadCleanupService(prisma as never, storage as never);

    await expect(service.cleanupOnce()).resolves.toBe(1);
    expect(prisma.uploadAttempt.updateMany).toHaveBeenCalledOnce();
  });

  it('leaves a storage failure pending for the next cleanup cycle', async () => {
    const prisma = {
      uploadAttempt: {
        findMany: vi.fn().mockResolvedValue([{
          id: 'attempt-retry', videoId: 'video-retry', status: 'FAILED',
          providerUploadId: 'multipart-retry', video: { id: 'video-retry', storageKey: 'videos/video-retry/source.mp4' },
        }]),
        updateMany: vi.fn(),
      },
    };
    const storage = { abortMultipart: vi.fn().mockRejectedValue(new Error('temporary storage failure')) };
    const service = new OrphanUploadCleanupService(prisma as never, storage as never);

    await expect(service.cleanupOnce()).resolves.toBe(0);
    expect(prisma.uploadAttempt.updateMany).not.toHaveBeenCalled();
  });

  it('does not start a second cleanup while one is running', async () => {
    let releaseFind: (attempts: never[]) => void = () => undefined;
    const findMany = vi.fn().mockImplementation(() => new Promise<never[]>((resolve) => {
      releaseFind = resolve;
    }));
    const prisma = { uploadAttempt: { findMany } };
    const service = new OrphanUploadCleanupService(prisma as never, { abortMultipart: vi.fn() } as never);

    const first = service.cleanupOnce();
    await expect(service.cleanupOnce()).resolves.toBe(0);
    releaseFind([]);
    await expect(first).resolves.toBe(0);
    expect(findMany).toHaveBeenCalledOnce();
  });
});
