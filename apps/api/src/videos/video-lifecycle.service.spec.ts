import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { VideoLifecycleService } from './video-lifecycle.service';

const video = {
  id: '33333333-3333-4333-8333-333333333333',
  storageKey: 'videos/video/source.mp4',
  thumbnailKey: 'thumbnails/videos/video/source.jpg',
  uploads: [{ status: 'STARTED', providerUploadId: 'multipart-1' }],
  pipelineRuns: [{ id: '44444444-4444-4444-8444-444444444444' }, { id: '55555555-5555-4555-8555-555555555555' }],
  clips: [{
    thumbnailKey: 'thumbnails/videos/video/clip-1.jpg',
    exports: [{ storageKey: 'exports/video/clip-1.mp4' }],
    captions: [
      { srtKey: 'exports/video/clip-1.srt', assKey: 'exports/video/clip-1.ass' },
      { srtKey: '/data/pipelines/local.srt', assKey: '/data/pipelines/local.ass' },
    ],
  }],
};

function fixture(found: typeof video | null = video) {
  const tx = {
    outboxEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 8 }) },
    video: { delete: vi.fn().mockResolvedValue(video) },
  };
  const prisma = {
    video: {
      findFirst: vi.fn().mockResolvedValue(found),
      findMany: vi.fn().mockResolvedValue(found ? [found] : []),
      delete: tx.video.delete,
    },
    outboxEvent: tx.outboxEvent,
    $transaction: vi.fn(async (input: Promise<unknown>[]) => Promise.all(input)),
  };
  const storage = {
    abortMultipart: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    deletePrefix: vi.fn().mockResolvedValue(0),
  };
  const media = { cleanupWorkspaces: vi.fn().mockResolvedValue({ requested: 2, removed: 2 }) };
  return { service: new VideoLifecycleService(prisma as never, storage as never, media as never), prisma, storage, media };
}

describe('VideoLifecycleService', () => {
  it('removes source, thumbnails, captions, exports, workdirs and outbox before the video row', async () => {
    const { service, prisma, storage, media } = fixture();
    await service.remove(video.id, '22222222-2222-4222-8222-222222222222');

    expect(storage.abortMultipart).toHaveBeenCalledWith(video.storageKey, 'multipart-1');
    expect(storage.delete.mock.calls.map(([key]) => key)).toEqual(expect.arrayContaining([
      video.storageKey,
      video.thumbnailKey,
      'thumbnails/videos/video/clip-1.jpg',
      'exports/video/clip-1.mp4',
      'exports/video/clip-1.srt',
      'exports/video/clip-1.ass',
    ]));
    expect(storage.delete).not.toHaveBeenCalledWith('/data/pipelines/local.srt');
    expect(storage.deletePrefix.mock.calls.map(([prefix]) => prefix)).toEqual(expect.arrayContaining([
      `videos/${video.id}/`,
      `imports/${video.id}/`,
      `thumbnails/videos/${video.id}/`,
      `exports/${video.id}/`,
    ]));
    expect(media.cleanupWorkspaces).toHaveBeenCalledWith(video.pipelineRuns.map((run) => run.id));
    expect(prisma.outboxEvent.deleteMany).toHaveBeenCalledWith({ where: { aggregateId: video.id } });
    expect(prisma.video.delete).toHaveBeenCalledWith({ where: { id: video.id } });
  });

  it('prepares the same complete cleanup before an account cascade', async () => {
    const { service, media } = fixture();
    await expect(service.prepareWorkspaceDeletion(['workspace-1'])).resolves.toEqual([video.id]);
    expect(media.cleanupWorkspaces).toHaveBeenCalled();
  });

  it('does not reveal videos from another tenant', async () => {
    const { service } = fixture(null);
    await expect(service.remove(video.id, 'other-workspace')).rejects.toBeInstanceOf(NotFoundException);
  });
});
