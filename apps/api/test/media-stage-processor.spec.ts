import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaStageProcessor } from '../src/media/media-stage.processor';

describe('MediaStageProcessor persistence', () => {
  let root: string;
  let artifacts: Record<string, string>;
  let prisma: any;
  let media: any;
  let storage: any;
  let usage: any;
  let processor: MediaStageProcessor;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'clipbr-media-'));
    artifacts = {};
    const values: Record<string, unknown> = {
      'whisperx-transcript': { language: 'en', confidence: 0.91, durationSeconds: 20, segments: [{ text: 'A useful transcript', speaker: 'SPEAKER_00', words: [{ word: 'useful', start: 0, end: 1 }] }] },
      'semantic-segments': { segments: [{ start: 0, end: 20, text: 'A useful transcript', speakers: ['SPEAKER_00'], boundaryReasons: ['topic'], emotion: { label: 'positive', confidence: 0.8 } }] },
      'viral-scores': { scores: [{ score: 88, categories: { curiosity: 80, authority: 70, controversy: 10, emotion: 90, business: 60, entertainment: 50, educational: 75, financial: 20 }, signals: { hook: 1 } }] },
      'clip-candidates': { clips: [{ start: 0, end: 20, score: 88, titleSuggestions: ['Title'], reason: 'Strong hook', text: 'A useful transcript', segmentIds: [0] }] },
      'captions-manifest': { captions: [{ clipId: 'clip-001', srt: `${root}/clip-001.srt`, ass: `${root}/clip-001.ass`, cueCount: 2 }] },
      'composition-manifest': { compositions: [{ clipId: 'clip-001', version: 'composition-v1', scenes: [], diagnostics: { status: 'fallback' } }] },
      'export-manifest': { storage: [
        { key: 'exports/video/clip-001.mp4', bytes: 100, mediaType: 'video/mp4' },
        { key: 'exports/video/clip-001.srt', bytes: 20, mediaType: 'application/x-subrip' },
        { key: 'exports/video/clip-001.ass', bytes: 30, mediaType: 'text/x-ssa' },
      ] },
    };
    for (const [kind, value] of Object.entries(values)) {
      const path = join(root, `${kind}.json`);
      await writeFile(path, JSON.stringify(value));
      artifacts[kind] = path;
    }

    const segment = { id: 'segment', startMs: 0n, endMs: 20_000n };
    const clip = {
      id: 'clip',
      videoId: 'video',
      aspectRatio: '9:16',
      startMs: 200n,
      endMs: 19_800n,
      captions: [{
        id: 'caption',
        template: 'marketing',
        cues: [{ start: 0, end: 1, words: [{ word: 'original', start: 0, end: 1 }] }],
        editedCues: [{ start: 0, end: 1, text: 'edited' }],
        style: { primaryColor: '#ff3366' },
      }],
    };
    prisma = {
      video: { findUnique: vi.fn().mockResolvedValue({ id: 'video', storageBucket: 'bucket', storageKey: 'videos/source.mp4', sourceUrl: null }), update: vi.fn() },
      transcript: { upsert: vi.fn() },
      segment: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn().mockResolvedValue([segment]) },
      viralScore: { upsert: vi.fn().mockResolvedValue({}) },
      clip: {
        deleteMany: vi.fn(), create: vi.fn().mockResolvedValue(clip), findMany: vi.fn().mockResolvedValue([clip]),
        updateMany: vi.fn(), update: vi.fn(),
      },
      seoMetadata: { create: vi.fn() },
      captionTrack: { deleteMany: vi.fn(), create: vi.fn(), update: vi.fn() },
      clipComposition: { upsert: vi.fn() },
      export: {
        findFirst: vi.fn().mockResolvedValue({ aspectRatio: '9:16', renderFingerprint: 'fingerprint', purpose: 'FINAL' }),
        findUnique: vi.fn().mockResolvedValue({ purpose: 'FINAL' }),
        create: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      $transaction: vi.fn(async (value: any) => typeof value === 'function' ? value(prisma) : Promise.all(value)),
    };
    media = {
      execute: vi.fn(async (job: any) => ({
        artifacts: artifacts[job.stage === 'transcription' ? 'whisperx-transcript' :
          job.stage === 'segmentation' ? 'semantic-segments' :
          job.stage === 'scoring' ? 'viral-scores' :
          job.stage === 'clips' ? 'clip-candidates' :
          job.stage === 'captions' ? 'captions-manifest' :
          job.stage === 'composition' ? 'composition-manifest' :
          job.stage === 'exports' ? 'export-manifest' : 'missing']
          ? [{ kind: job.stage === 'transcription' ? 'whisperx-transcript' :
            job.stage === 'segmentation' ? 'semantic-segments' :
            job.stage === 'scoring' ? 'viral-scores' :
            job.stage === 'clips' ? 'clip-candidates' :
            job.stage === 'captions' ? 'captions-manifest' :
            job.stage === 'composition' ? 'composition-manifest' : 'export-manifest', path: artifacts[job.stage === 'transcription' ? 'whisperx-transcript' : job.stage === 'segmentation' ? 'semantic-segments' : job.stage === 'scoring' ? 'viral-scores' : job.stage === 'clips' ? 'clip-candidates' : job.stage === 'captions' ? 'captions-manifest' : job.stage === 'composition' ? 'composition-manifest' : 'export-manifest'] }]
          : [],
        metrics: job.stage === 'ingestion' ? { durationSeconds: 20, video: { width: 640, height: 360, frameRate: 24, codec: 'h264' }, audio: { codec: 'aac' } } : {},
      })),
      seo: vi.fn().mockResolvedValue({ titles: [{ title: 'SEO title', ctrScore: 92 }], description: 'Description', hashtags: ['#clipbr'], keywords: ['video'] }),
    };
    usage = {
      assertCanProcessVideo: vi.fn().mockResolvedValue({}),
      recordProcessingMinutes: vi.fn().mockResolvedValue(undefined),
    };
    storage = {
      upload: vi.fn().mockResolvedValue({ etag: 'etag' }),
      uploadUrl: vi.fn(async (key: string) => `https://storage.test/upload/${key}`),
      metadata: vi.fn(async (key: string) => ({
        bytes: BigInt(key.endsWith('.srt') ? 20 : key.endsWith('.ass') ? 30 : 100),
        contentType: key.endsWith('.mp4') ? 'video/mp4' : 'text/plain',
      })),
      downloadUrl: vi.fn(async (key: string) => `https://storage.test/${key}`),
    };
    processor = new MediaStageProcessor(
      prisma,
      media,
      storage,
      {
        get: (key: string) => ({
          MEDIA_WORKER_DATA_DIR: root,
          MEDIA_DIARIZATION_ENABLED: false,
          MEDIA_TRANSCRIPTION_BATCH_SIZE: 1,
          FFMPEG_PRESET: 'veryfast',
          FFMPEG_CRF: 22,
          RENDER_MAX_HEIGHT: 720,
          RENDER_MAX_SOURCE_SHORT_SIDE: 2160,
          COMPOSITION_V1_ENABLED: true,
          COMPOSITION_V1_ROLLOUT_PERCENT: 100,
          MEDIA_ACCELERATOR: 'cpu',
          AI_EXECUTION_MODE: 'local',
          STT_PROVIDER: 'whisperx',
          GPU_PROVIDER: 'none',
          AUTO_RENDER_MODE: 'all',
          AI_COST_LIMIT_USD_PER_SOURCE_HOUR: 1,
          FINAL_MAX_SHORT_SIDE: 1080,
        } as any)[key],
      } as any,
      usage,
    );
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  const job = (stage: string) => ({ stage, videoId: 'video', pipelineRunId: 'run', stageExecutionId: 'execution' }) as any;
  const renderJob = (stage: string) => ({
    ...job(stage),
    clipId: 'clip',
    exportId: 'export',
    sourcePipelineRunId: 'source-run',
    renderFingerprint: 'fingerprint',
  }) as any;

  it('persists every pipeline stage and passes release-safe options', async () => {
    for (const stage of ['ingestion', 'transcription', 'segmentation', 'scoring', 'clips', 'captions', 'composition']) {
      await processor.process(job(stage));
    }
    await processor.process(renderJob('rendering'));
    await processor.process(renderJob('exports'));
    expect(prisma.video.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ width: 640, videoCodec: 'h264' }) }));
    expect(usage.assertCanProcessVideo).toHaveBeenCalledWith('video');
    expect(usage.recordProcessingMinutes).toHaveBeenCalledWith('video');
    expect(prisma.transcript.upsert).toHaveBeenCalled();
    expect(prisma.segment.createMany).toHaveBeenCalled();
    expect(prisma.viralScore.upsert).toHaveBeenCalled();
    expect(prisma.clip.create).toHaveBeenCalled();
    expect(prisma.seoMetadata.create).toHaveBeenCalled();
    expect(prisma.captionTrack.create).toHaveBeenCalled();
    expect(prisma.clipComposition.upsert).toHaveBeenCalled();
    expect(prisma.export.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'export', status: { in: ['QUEUED', 'PROCESSING'] } } }));
    expect(prisma.export.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'export' }, data: expect.objectContaining({ status: 'READY' }) }));
    expect(prisma.clip.update).toHaveBeenCalled();
    expect(media.execute).toHaveBeenCalledWith(expect.objectContaining({ stage: 'transcription' }), expect.anything(), expect.objectContaining({ diarize: false, batchSize: 1 }), undefined);
    expect(media.execute).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'rendering' }),
      expect.anything(),
      expect.objectContaining({
        clipIndex: 0,
        preserveSourceQuality: true,
        compositionV1: true,
        maxSourceShortSide: 1080,
        clipOverride: { clipIndex: 0, start: 0.2, end: 19.8 },
        captionOverride: expect.objectContaining({ template: 'marketing', cues: [{ start: 0, end: 1, text: 'edited' }] }),
      }),
      undefined,
    );
  });

  it('uses source URLs and rejects missing videos or unsafe artifacts', async () => {
    prisma.video.findUnique.mockResolvedValueOnce({ id: 'video', storageBucket: 'bucket', storageKey: 'key', sourceUrl: 'https://example.test/video' });
    await processor.process(job('ingestion'));
    expect(media.execute).toHaveBeenLastCalledWith(expect.anything(), undefined, {}, 'https://example.test/video');
    prisma.video.findUnique.mockResolvedValueOnce(null);
    await expect(processor.process(job('ingestion'))).rejects.toThrow('Video not found');

    const outside = join(tmpdir(), 'outside-artifact.json');
    await writeFile(outside, '{}');
    media.execute.mockResolvedValueOnce({ artifacts: [{ kind: 'whisperx-transcript', path: outside }], metrics: {} });
    await expect(processor.process(job('transcription'))).rejects.toMatchObject({ code: 'ARTIFACT_PATH_REJECTED' });
    await rm(outside, { force: true });
  });

  it('clears stale caption files when the edited render has no valid captions', async () => {
    media.execute.mockResolvedValueOnce({
      artifacts: [],
      metrics: { storage: [{ key: 'exports/video/export/clip-001.mp4', bytes: 100, mediaType: 'video/mp4' }] },
    });

    await processor.process(renderJob('exports'));

    expect(prisma.captionTrack.update).toHaveBeenCalledWith({
      where: { id: 'caption' },
      data: { srtKey: null, assKey: null },
    });
  });

  it('creates one idempotent final export per clip for automatic production rendering', async () => {
    prisma.export.findFirst.mockResolvedValueOnce(null);
    prisma.export.create.mockResolvedValueOnce({
      id: 'automatic-export',
      clipId: 'clip',
      purpose: 'FINAL',
      status: 'QUEUED',
      storageKey: null,
    });
    media.execute.mockResolvedValueOnce({ artifacts: [], metrics: {} });

    await processor.process(job('rendering'));

    expect(prisma.export.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ clipId: 'clip', purpose: 'FINAL', status: 'QUEUED', sourcePipelineRunId: 'run' }),
    });
    expect(media.execute).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'rendering' }),
      { bucket: 'bucket', key: 'videos/source.mp4' },
      expect.objectContaining({
        purpose: 'FINAL',
        clipIndexes: [0],
        batchOutputs: [expect.objectContaining({ clipId: 'clip', exportId: 'automatic-export' })],
      }),
      undefined,
    );
    expect(storage.uploadUrl).not.toHaveBeenCalled();
  });

  it('marks a clip for review when visual QA still fails after the conservative rerender', async () => {
    media.execute.mockResolvedValueOnce({
      artifacts: [],
      metrics: { quality: { status: 'review', failedClipIds: ['clip-001'], rerendered: ['clip-001'] } },
    });

    await processor.process(renderJob('rendering'));

    expect(prisma.clip.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['clip'] } },
      data: { status: 'REVIEW_REQUIRED' },
    });
  });

  it('does not retry YouTube auth/bot-check import failures', async () => {
    prisma.video.findUnique.mockResolvedValueOnce({
      id: 'video',
      storageBucket: 'bucket',
      storageKey: 'videos/source.mp4',
      sourceUrl: 'https://www.youtube.com/watch?v=qHlquy4-YEs',
    });
    media.execute.mockRejectedValueOnce(
      Object.assign(new Error('O YouTube bloqueou a importação automática deste link.'), {
        code: 'URL_IMPORT_AUTH_REQUIRED',
      }),
    );

    const promise = processor.process(job('ingestion'));
    await expect(promise).rejects.toMatchObject({
      code: 'URL_IMPORT_AUTH_REQUIRED',
      message: 'O YouTube bloqueou a importação automática deste link.',
    });
    await expect(promise).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('classifies plan limits as user-actionable terminal failures', async () => {
    usage.assertCanProcessVideo.mockRejectedValueOnce(
      new HttpException('O vídeo excede a duração máxima do plano atual.', 402),
    );

    const promise = processor.process(job('ingestion'));
    await expect(promise).rejects.toMatchObject({
      code: 'PLAN_LIMIT_EXCEEDED',
      message: 'O vídeo excede a duração máxima do plano atual.',
    });
    await expect(promise).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
