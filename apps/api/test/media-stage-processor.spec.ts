import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const clip = { id: 'clip', videoId: 'video', aspectRatio: '9:16', captions: [{ id: 'caption' }] };
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
      export: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn() },
      $transaction: vi.fn(async (value: any) => typeof value === 'function' ? value(prisma) : Promise.all(value)),
    };
    media = {
      execute: vi.fn(async (job: any) => ({
        artifacts: artifacts[job.stage === 'transcription' ? 'whisperx-transcript' :
          job.stage === 'segmentation' ? 'semantic-segments' :
          job.stage === 'scoring' ? 'viral-scores' :
          job.stage === 'clips' ? 'clip-candidates' :
          job.stage === 'captions' ? 'captions-manifest' :
          job.stage === 'exports' ? 'export-manifest' : 'missing']
          ? [{ kind: job.stage === 'transcription' ? 'whisperx-transcript' :
            job.stage === 'segmentation' ? 'semantic-segments' :
            job.stage === 'scoring' ? 'viral-scores' :
            job.stage === 'clips' ? 'clip-candidates' :
            job.stage === 'captions' ? 'captions-manifest' : 'export-manifest', path: artifacts[job.stage === 'transcription' ? 'whisperx-transcript' : job.stage === 'segmentation' ? 'semantic-segments' : job.stage === 'scoring' ? 'viral-scores' : job.stage === 'clips' ? 'clip-candidates' : job.stage === 'captions' ? 'captions-manifest' : 'export-manifest'] }]
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
      downloadUrl: vi.fn(async (key: string) => `https://storage.test/${key}`),
    };
    processor = new MediaStageProcessor(prisma, media, storage, { get: (key: string) => ({ MEDIA_WORKER_DATA_DIR: root, MEDIA_DIARIZATION_ENABLED: false, MEDIA_TRANSCRIPTION_BATCH_SIZE: 1 } as any)[key] } as any, usage);
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  const job = (stage: string) => ({ stage, videoId: 'video', pipelineRunId: 'run', stageExecutionId: 'execution' }) as any;

  it('persists every pipeline stage and passes release-safe options', async () => {
    for (const stage of ['ingestion', 'transcription', 'segmentation', 'scoring', 'clips', 'captions', 'rendering', 'exports']) {
      await processor.process(job(stage));
    }
    expect(prisma.video.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ width: 640, videoCodec: 'h264' }) }));
    expect(usage.assertCanProcessVideo).toHaveBeenCalledWith('video');
    expect(usage.recordProcessingMinutes).toHaveBeenCalledWith('video');
    expect(prisma.transcript.upsert).toHaveBeenCalled();
    expect(prisma.segment.createMany).toHaveBeenCalled();
    expect(prisma.viralScore.upsert).toHaveBeenCalled();
    expect(prisma.clip.create).toHaveBeenCalled();
    expect(prisma.seoMetadata.create).toHaveBeenCalled();
    expect(prisma.captionTrack.create).toHaveBeenCalled();
    expect(prisma.export.create).toHaveBeenCalled();
    expect(prisma.clip.update).toHaveBeenCalled();
    expect(media.execute).toHaveBeenCalledWith(expect.objectContaining({ stage: 'transcription' }), expect.anything(), expect.objectContaining({ diarize: false, batchSize: 1 }), undefined);
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
});
