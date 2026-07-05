import { describe, expect, it, vi } from 'vitest';
import { AnalyticsController } from './analytics.controller';

const user = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  email: 'ana@picashorts.test',
};

function makeController() {
  const prisma = {
    video: {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([
        {
          id: '33333333-3333-4333-8333-333333333333',
          originalFilename: 'demo.mp4',
          title: 'Demo',
          status: 'UPLOADED',
          mimeType: 'video/mp4',
          container: 'mp4',
          sizeBytes: 12_345n,
          durationMs: 65_000n,
          thumbnailKey: 'thumbs/demo.jpg',
          storageKey: 'videos/demo/source.mp4',
          createdAt: new Date('2026-07-04T00:00:00Z'),
          updatedAt: new Date('2026-07-04T00:01:00Z'),
          _count: { clips: 2 },
          pipelineRuns: [{ status: 'SUCCEEDED', currentStage: 'EXPORTS' }],
        },
      ]),
    },
    clip: { count: vi.fn().mockResolvedValue(2) },
    export: { count: vi.fn().mockResolvedValue(1) },
    usageEvent: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 3n, costCents: 0 } }),
      count: vi.fn().mockResolvedValue(1),
    },
    pipelineRun: { groupBy: vi.fn().mockResolvedValue([{ status: 'SUCCEEDED', _count: { _all: 1 } }]) },
    project: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([{ day: new Date('2026-07-04T00:00:00Z'), events: 1n, costCents: 0n }]),
  };
  const storage = { downloadUrl: vi.fn(async (key: string) => `https://storage.test/${key}`) };
  const config = { get: vi.fn(() => 30) };
  return { controller: new AnalyticsController(prisma as never, storage as never, config as never), storage };
}

describe('AnalyticsController', () => {
  it('serializes overview without leaking BigInt values', async () => {
    const { controller } = makeController();

    const payload = await controller.overview(user);
    const encoded = JSON.stringify(payload);

    expect(encoded).toContain('"sizeBytes":"12345"');
    expect(encoded).toContain('"processingMinutes":"3"');
    expect(encoded).toContain('"events":"1"');
    expect(payload).toMatchObject({
      videos: 1,
      clips: 2,
      recentVideos: [{ durationSeconds: 65, thumbnailUrl: 'https://storage.test/thumbs/demo.jpg' }],
      activity: [{ day: '2026-07-04', events: '1', costCents: '0' }],
    });
  });
});
