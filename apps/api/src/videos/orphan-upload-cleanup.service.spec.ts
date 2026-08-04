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
});
