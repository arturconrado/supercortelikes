import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoImportService } from './video-import.service';

const user = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  email: 'ana@clipbr.test',
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    status: 'UPLOADED',
    originalFilename: 'source.mp4',
    storageKey: 'imports/source.mp4',
    storageBucket: 'bucket',
    mimeType: 'video/mp4',
    container: 'mp4',
    sizeBytes: null,
    checksumSha256: null,
    storageEtag: null,
    failureCode: null,
    durationMs: null,
    projectId: null,
    processingOptions: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

function harness() {
  const createdVideos: any[] = [];
  const tx = {
    video: {
      create: vi.fn(async ({ data }) => {
        const value = record(data);
        createdVideos.push(value);
        return value;
      }),
    },
    uploadAttempt: { create: vi.fn() },
    outboxEvent: { create: vi.fn() },
    pipelineRun: { create: vi.fn() },
    stageExecution: { create: vi.fn() },
  };
  const prisma = {
    uploadAttempt: { findUnique: vi.fn().mockResolvedValue(null) },
    project: { findFirst: vi.fn().mockResolvedValue({ id: 'project' }) },
    $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(tx)),
  } as any;
  const service = new VideoImportService(prisma, { get: vi.fn(() => 'bucket') } as any);
  return { service, prisma, tx, createdVideos };
}

describe('VideoImportService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['https://www.youtube.com/watch?v=VYDE529RzNk', /^youtube-VYDE529RzNk\.mp4$/, 'mp4', 'video/mp4'],
    ['https://www.youtube.com/shorts/VYDE529RzNk', /^youtube-VYDE529RzNk\.mp4$/, 'mp4', 'video/mp4'],
    ['https://www.loom.com/share/abcdef123456', /^loom-abcdef123456\.mp4$/, 'mp4', 'video/mp4'],
    ['https://drive.google.com/file/d/drivePublicId123/view', /^google-drive-drivePublicId123\.mp4$/, 'mp4', 'video/mp4'],
    ['https://cdn.example.com/media/demo.webm', /^demo\.webm$/, 'webm', 'video/webm'],
    ['https://video.vendor.example/public/abc', /^remote-video\.vendor\.example\.mp4$/, 'mp4', 'video/mp4'],
  ])('creates a pipeline-ready import for %s', async (url, filename, container, mimeType) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: vi.fn() }));
    const { service, tx, createdVideos } = harness();
    const result = await service.import(url, 'import-key-1234', user, undefined, { aspectRatio: '4:5' });

    expect(result.status).toBe('UPLOADED');
    expect(createdVideos[0].originalFilename).toMatch(filename);
    expect(createdVideos[0].container).toBe(container);
    expect(createdVideos[0].mimeType).toBe(mimeType);
    expect(createdVideos[0].processingOptions).toMatchObject({ aspectRatio: '4:5', targetPlatform: 'INSTAGRAM_REELS' });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: 'video.uploaded.v1' }) }));
  });

  it('uses YouTube oEmbed metadata as the initial display title', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ title: '  A GWM IMPRESSIONOU A TODOS! Novo ORA 5 Por R$159.000. Confira!  ' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { service, createdVideos } = harness();

    await expect(service.import('https://www.youtube.com/watch?v=qHlquy4-YEs', 'import-key-1234', user))
      .resolves.toMatchObject({ title: 'A GWM IMPRESSIONOU A TODOS! Novo ORA 5 Por R$159.000. Confira!' });

    expect(createdVideos[0].title).toBe('A GWM IMPRESSIONOU A TODOS! Novo ORA 5 Por R$159.000. Confira!');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('youtube.com/oembed');
  });

  it('returns previous imports idempotently', async () => {
    const { service, prisma } = harness();
    prisma.uploadAttempt.findUnique.mockResolvedValueOnce({ video: record({ originalFilename: 'cached.mp4' }) });

    await expect(service.import('https://youtu.be/VYDE529RzNk', 'import-key-1234', user)).resolves.toMatchObject({
      originalFilename: 'cached.mp4',
      reused: true,
    });
  });

  it('rejects unsupported, private and malformed URLs', async () => {
    const { service } = harness();
    await expect(service.import('not-a-url', 'import-key-1234', user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.import('https://localhost/video.mp4', 'import-key-1234', user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.import('http://example.com/video.mp4', 'import-key-1234', user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.import('https://www.youtube.com/watch?v=bad', 'import-key-1234', user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.import('https://www.loom.com/share/', 'import-key-1234', user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates idempotency keys and project ownership', async () => {
    const { service, prisma } = harness();
    await expect(service.import('https://youtu.be/VYDE529RzNk', '../bad', user)).rejects.toBeInstanceOf(BadRequestException);
    prisma.project.findFirst.mockResolvedValueOnce(null);
    await expect(service.import('https://youtu.be/VYDE529RzNk', 'import-key-1234', user, '44444444-4444-4444-8444-444444444444')).rejects.toBeInstanceOf(NotFoundException);
  });
});
