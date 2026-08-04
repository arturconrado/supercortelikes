import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ProjectProcessingService } from './project-processing.service';

const user = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  email: 'qa@picashorts.test',
};

function prisma(active = false) {
  const tx = {
    $queryRaw: vi.fn(),
    video: { update: vi.fn() },
    outboxEvent: { create: vi.fn() },
    pipelineRun: { create: vi.fn(), count: vi.fn().mockResolvedValue(0) },
    stageExecution: { create: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    project: {
      findFirst: vi.fn().mockResolvedValue({
        id: '33333333-3333-4333-8333-333333333333',
        videos: [{
          id: '44444444-4444-4444-8444-444444444444',
          status: 'UPLOADED',
          storageKey: 'videos/source.mp4',
          workspaceId: user.workspaceId,
          projectId: '33333333-3333-4333-8333-333333333333',
          durationMs: 60_000n,
          _count: { clips: 0 },
          pipelineRuns: active ? [{ id: 'active' }] : [],
        }],
      }),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    usage: { assertCanProcessVideos: vi.fn() },
    tx,
  };
}

describe('ProjectProcessingService', () => {
  it('queues a fresh isolated pipeline run with a complete outbox contract', async () => {
    const database = prisma();
    const service = new ProjectProcessingService(database as never, database.usage as never);
    const result = await service.reprocess('33333333-3333-4333-8333-333333333333', user);

    expect(result.videosQueued).toBe(1);
    expect(result.pipelineRunIds).toHaveLength(1);
    expect(database.tx.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: 'video.uploaded.v2',
        payload: expect.objectContaining({ tenantId: user.workspaceId, reprocessed: true }),
      }),
    }));
    expect(database.tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'project.reprocess', workspaceId: user.workspaceId }),
    }));
  });

  it('refuses to duplicate an active project pipeline', async () => {
    const database = prisma(true);
    const service = new ProjectProcessingService(database as never, database.usage as never);
    await expect(service.reprocess('33333333-3333-4333-8333-333333333333', user)).rejects.toBeInstanceOf(ConflictException);
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it('preserves completed clips and refuses destructive reprocessing', async () => {
    const database = prisma();
    const project = await database.project.findFirst();
    project.videos[0]._count.clips = 1;
    database.project.findFirst.mockResolvedValue(project);
    const service = new ProjectProcessingService(database as never, database.usage as never);

    await expect(service.reprocess('33333333-3333-4333-8333-333333333333', user)).rejects.toBeInstanceOf(ConflictException);
    expect(database.usage.assertCanProcessVideos).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it('serializes concurrent reprocessing and refuses a run created while waiting for the lock', async () => {
    const database = prisma();
    database.tx.pipelineRun.count.mockResolvedValue(1);
    const service = new ProjectProcessingService(database as never, database.usage as never);

    await expect(service.reprocess('33333333-3333-4333-8333-333333333333', user)).rejects.toBeInstanceOf(ConflictException);
    expect(database.tx.$queryRaw).toHaveBeenCalledOnce();
    expect(database.tx.outboxEvent.create).not.toHaveBeenCalled();
  });
});
