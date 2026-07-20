import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ContentController, sseResponseHeaders } from './content.controller';

const user = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  email: 'ana@clipbr.test',
};

const clip = {
  id: '33333333-3333-4333-8333-333333333333',
  videoId: '44444444-4444-4444-8444-444444444444',
  startMs: 0n,
  endMs: 20_000n,
  score: 88,
  title: 'Clip',
  titleSuggestions: ['Clip'],
  reason: 'Strong hook',
  aspectRatio: '9:16',
  status: 'SUGGESTED',
  thumbnailKey: null,
  captions: [],
  exports: [],
  seo: { description: 'Description', hashtags: ['#clipbr'], titles: ['SEO title'] },
  video: {
    id: '44444444-4444-4444-8444-444444444444',
    workspaceId: user.workspaceId,
    storageKey: 'videos/video/source.mp4',
    sourceUrl: null,
    durationMs: 20_000n,
  },
};

function prisma(overrides: Record<string, unknown> = {}) {
  const db: any = {
    video: {
      findFirst: vi.fn().mockResolvedValue({
        id: clip.videoId,
        status: 'UPLOADED',
        failureCode: null,
        failureMessage: null,
        pipelineRuns: [{
          id: 'run',
          status: 'RUNNING',
          currentStage: 'TRANSCRIPTION',
          startedAt: new Date('2026-07-01T00:00:00Z'),
          completedAt: null,
          failureCode: null,
          failureMessage: null,
          stages: [{ id: 'stage', stage: 'INGESTION', status: 'SUCCEEDED', attempts: 1, startedAt: null, completedAt: null, errorCode: null, errorMessage: null }],
          deadLetters: [{ id: 'dlq', originalQueue: 'transcription', errorCode: 'FAILED', errorMessage: 'boom', attempts: 3, createdAt: new Date('2026-07-01T00:01:00Z') }],
        }],
      }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    transcript: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'transcript',
        videoId: clip.videoId,
        language: 'pt',
        confidence: 0.9,
        fullText: 'Olá mundo',
        words: [{ word: 'Olá', start: 0, end: 1 }],
        speakers: [],
        durationMs: 20_000n,
        createdAt: new Date('2026-07-01T00:00:00Z'),
        updatedAt: new Date('2026-07-01T00:00:00Z'),
      }),
    },
    clip: {
      findMany: vi.fn().mockResolvedValue([clip]),
      findFirst: vi.fn().mockResolvedValue(clip),
      update: vi.fn().mockResolvedValue(clip),
    },
    seoMetadata: { upsert: vi.fn().mockResolvedValue({}) },
    captionTrack: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    export: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'export', clipId: clip.id, format: 'MP4', aspectRatio: '9:16', status: 'QUEUED', sizeBytes: null }),
      update: vi.fn().mockResolvedValue({}),
    },
    deadLetterJob: { findFirst: vi.fn().mockResolvedValue({ id: 'dlq' }) },
    pipelineRun: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    stageExecution: { create: vi.fn().mockResolvedValue({}) },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (value: any) => typeof value === 'function' ? value(db) : Promise.all(value)),
    ...overrides,
  };
  return db;
}

function makeController(db = prisma()) {
  const storage = { downloadUrl: vi.fn(async (key: string) => `https://storage.test/${key}`) };
  const renderRequests = { request: vi.fn().mockResolvedValue({ id: 'export', clipId: clip.id, format: 'MP4', aspectRatio: '9:16', status: 'QUEUED', sizeBytes: null }) };
  return {
    db,
    storage,
    renderRequests,
    controller: new ContentController(
      db,
      { redrive: vi.fn().mockResolvedValue('event') } as any,
      storage as any,
      renderRequests as any,
      { get: vi.fn().mockReturnValue(['https://picashorts.com']) } as any,
    ),
  };
}

describe('ContentController', () => {
  it('preserves CORS headers when the SSE response takes over the raw socket', () => {
    expect(sseResponseHeaders('https://picashorts.com', ['https://picashorts.com'])).toMatchObject({
      'Access-Control-Allow-Origin': 'https://picashorts.com',
      'Content-Type': 'text/event-stream; charset=utf-8',
      Vary: 'Origin',
    });
    expect(sseResponseHeaders('https://evil.test', ['https://picashorts.com'])).not.toHaveProperty('Access-Control-Allow-Origin');
  });

  it('exposes pipeline, transcript and video clip state', async () => {
    const { controller } = makeController();
    await expect(controller.videoPipeline(user, clip.videoId)).resolves.toMatchObject({ progress: 17, run: { openDeadLetters: [{ id: 'dlq' }] } });
    await expect(controller.videoTranscript(user, clip.videoId)).resolves.toMatchObject({ language: 'pt', detectedLanguage: 'pt', durationSeconds: 20 });
    const clips = await controller.videoClips(user, clip.videoId) as Array<Record<string, unknown>>;
    expect(clips).toMatchObject([
      {
        description: 'Description',
        hashtags: ['#clipbr'],
        playbackUrl: 'https://storage.test/videos/video/source.mp4#t=0,20',
      },
    ]);
    expect(clips[0]).not.toHaveProperty('renderUrl');
    expect(clips[0]).not.toHaveProperty('downloadUrl');
  });

  it('retries open dead letters and reports missing retry work', async () => {
    const { controller, db } = makeController();
    await expect(controller.retryVideo(user, clip.videoId)).resolves.toEqual({ eventId: 'event' });
    db.deadLetterJob.findFirst.mockResolvedValueOnce(null);
    await expect(controller.retryVideo(user, clip.videoId)).rejects.toBeInstanceOf(BadRequestException);
    db.video.findFirst.mockResolvedValueOnce(null);
    await expect(controller.videoPipeline(user, clip.videoId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates clip content, timing and captions', async () => {
    const { controller, db } = makeController();
    await expect(controller.updateClip(user, clip.id, { title: 'New', description: 'Desc', hashtags: ['#new'] })).resolves.toMatchObject({ id: clip.id });
    expect(db.seoMetadata.upsert).toHaveBeenCalled();
    await expect(controller.updateTiming(user, clip.id, { startSeconds: 2, endSeconds: 12 })).resolves.toMatchObject({ id: clip.id });
    await expect(controller.updateTiming(user, clip.id, { startSeconds: 12, endSeconds: 2 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.updateTiming(user, clip.id, { startSeconds: 2, endSeconds: 21 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.updateCaptions(user, clip.id, { cues: [{ text: 'Olá' }], language: 'pt' })).resolves.toMatchObject({ id: clip.id });
    db.captionTrack.findFirst.mockResolvedValueOnce({ id: 'caption' });
    await expect(controller.updateCaptions(user, clip.id, { cues: [{ text: 'Editado' }] })).resolves.toMatchObject({ id: clip.id });
    expect(db.captionTrack.update).toHaveBeenCalled();
  });

  it('creates render/export jobs and reuses existing jobs', async () => {
    const { controller, renderRequests } = makeController();
    await expect(controller.renderClip(user, clip.id, { aspectRatio: '1:1', force: true })).resolves.toMatchObject({ status: 'QUEUED' });
    expect(renderRequests.request).toHaveBeenCalledWith(user, { clipId: clip.id, format: 'MP4', aspectRatio: '1:1', force: true });

    renderRequests.request.mockResolvedValueOnce({ id: 'ready', clipId: clip.id, format: 'MP4', aspectRatio: '9:16', status: 'READY', sizeBytes: '10' });
    await expect(controller.exportClip(user, clip.id, { format: 'MP4' })).resolves.toMatchObject({ id: 'ready', sizeBytes: '10' });
  });

  it('returns not found for missing transcript or clip ownership', async () => {
    const { controller, db } = makeController();
    db.transcript.findFirst.mockResolvedValueOnce(null);
    await expect(controller.videoTranscript(user, clip.videoId)).rejects.toBeInstanceOf(NotFoundException);
    db.clip.findFirst.mockResolvedValueOnce(null);
    await expect(controller.clip(user, clip.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
