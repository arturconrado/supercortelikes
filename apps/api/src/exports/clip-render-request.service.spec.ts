import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ClipRenderRequestService } from './clip-render-request.service';

const user = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  email: 'ana@picashorts.test',
};

const clip = {
  id: '33333333-3333-4333-8333-333333333333',
  videoId: '44444444-4444-4444-8444-444444444444',
  startMs: 1_000n,
  endMs: 31_000n,
  aspectRatio: '9:16',
  updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  captions: [
    {
      id: 'caption',
      template: 'podcast',
      language: 'pt',
      cues: [{ text: 'Olá mundo' }],
      editedCues: null,
      style: { primaryColor: '#fff' },
      updatedAt: new Date('2026-07-01T00:01:00.000Z'),
    },
  ],
  video: {
    workspace: {
      plan: 'FREE',
      brandKits: [{ id: 'brand', logoKey: 'logos/picashorts.png', watermark: { position: 'bottom' }, updatedAt: new Date('2026-07-01T00:02:00.000Z') }],
    },
  },
};

function prisma(overrides: Record<string, unknown> = {}) {
  const exportItem = {
    id: '55555555-5555-4555-8555-555555555555',
    clipId: clip.id,
    format: 'MP4',
    aspectRatio: '9:16',
    status: 'QUEUED',
    sizeBytes: null,
    renderFingerprint: 'fingerprint',
    sourcePipelineRunId: '66666666-6666-4666-8666-666666666666',
  };
  const db: any = {
    clip: {
      findFirst: vi.fn().mockResolvedValue(clip),
      update: vi.fn().mockResolvedValue({ ...clip, status: 'RENDERING' }),
    },
    pipelineRun: {
      findFirst: vi.fn().mockResolvedValue({ id: '66666666-6666-4666-8666-666666666666' }),
      create: vi.fn().mockResolvedValue({}),
    },
    stageExecution: { create: vi.fn().mockResolvedValue({}) },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    export: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(exportItem),
    },
    $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    ...overrides,
  };
  return db;
}

function service(db = prisma()) {
  return new ClipRenderRequestService(
    db,
    { get: vi.fn((key: string) => ({ FFMPEG_PRESET: 'veryfast', FFMPEG_CRF: 22, RENDER_MAX_HEIGHT: 720 })[key]) } as any,
  );
}

describe('ClipRenderRequestService', () => {
  it('reuses an active export with the same render fingerprint', async () => {
    const ready = { id: 'ready', clipId: clip.id, status: 'READY', sizeBytes: 10n };
    const db = prisma({ export: { findFirst: vi.fn().mockResolvedValue(ready), create: vi.fn() } });

    await expect(service(db).request(user, { clipId: clip.id })).resolves.toMatchObject({ id: 'ready', sizeBytes: '10' });

    expect(db.export.create).not.toHaveBeenCalled();
    expect(db.export.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        clipId: clip.id,
        renderFingerprint: expect.any(String),
        status: { in: ['READY', 'QUEUED', 'PROCESSING'] },
      }),
    }));
  });

  it('creates a queued export and routes only the requested clip to rendering', async () => {
    const db = prisma();
    const result = await service(db).request(user, { clipId: clip.id, aspectRatio: '1:1', force: true });

    expect(result).toMatchObject({ id: '55555555-5555-4555-8555-555555555555', status: 'QUEUED' });
    expect(db.clip.update).toHaveBeenCalledWith({ where: { id: clip.id }, data: { aspectRatio: '1:1', status: 'SUGGESTED' } });
    expect(db.export.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        id: expect.any(String),
        clipId: clip.id,
        status: 'QUEUED',
        renderFingerprint: expect.any(String),
        sourcePipelineRunId: '66666666-6666-4666-8666-666666666666',
      }),
    }));
    expect(db.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: 'clip.render.requested.v1',
        payload: expect.objectContaining({
          clipId: clip.id,
          exportId: expect.any(String),
          sourcePipelineRunId: '66666666-6666-4666-8666-666666666666',
          renderFingerprint: expect.any(String),
          stage: 'rendering',
        }),
      }),
    }));
  });

  it('does not render before captions are completed', async () => {
    const db = prisma({ pipelineRun: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() } });
    await expect(service(db).request(user, { clipId: clip.id })).rejects.toBeInstanceOf(ConflictException);
    expect(db.export.create).not.toHaveBeenCalled();
  });
});
