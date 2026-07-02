import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { UnrecoverableError } from 'bullmq';
import type { Environment } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import type { PipelineJob } from '../queues/pipeline.constants';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/storage.port';
import { UsageService } from '../usage/usage.service';
import { MediaWorkerClient, type MediaStageResponse } from './media-worker.client';
import { normalizeVideoProcessingOptions } from '../videos/video-processing-options';
import { limitsFor } from '../usage/entitlements';

@Injectable()
export class MediaStageProcessor {
  private readonly dataRoot: string;
  private readonly diarizationEnabled: boolean;
  private readonly transcriptionBatchSize: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaWorkerClient,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    config: ConfigService<Environment, true>,
    private readonly usage: UsageService,
  ) {
    this.dataRoot = resolve(config.get('MEDIA_WORKER_DATA_DIR', { infer: true }));
    this.diarizationEnabled = config.get('MEDIA_DIARIZATION_ENABLED', { infer: true });
    this.transcriptionBatchSize = config.get('MEDIA_TRANSCRIPTION_BATCH_SIZE', { infer: true });
  }

  async process(job: PipelineJob): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: job.videoId },
      include: {
        workspace: {
          select: {
            plan: true,
            brandKits: {
              orderBy: { createdAt: 'asc' },
              take: 1,
              select: { name: true, logoKey: true, watermark: true },
            },
          },
        },
      },
    });
    if (!video) throw new NotFoundException('Video not found for pipeline stage');
    const processingOptions = normalizeVideoProcessingOptions(video.processingOptions as never);
    const options = await this.options(job, video.storageBucket, processingOptions, video);
    const response = await this.media.execute(
      job,
      video.sourceUrl ? undefined : { bucket: video.storageBucket, key: video.storageKey },
      options,
      video.sourceUrl ?? undefined,
    );
    await this.persist(job, response);
  }

  private async options(
    job: PipelineJob,
    bucket: string,
    processing: ReturnType<typeof normalizeVideoProcessingOptions>,
    video?: {
      workspace?: {
        plan: Parameters<typeof limitsFor>[0];
        brandKits: Array<{ name: string; logoKey: string | null; watermark: Prisma.JsonValue | null }>;
      } | null;
    },
  ): Promise<Record<string, unknown>> {
    const stage = job.stage;
    if (stage === 'transcription') {
      return { diarize: this.diarizationEnabled, batchSize: this.transcriptionBatchSize };
    }
    if (stage === 'clips') {
      return {
        count: processing.clipCount,
        minimumDuration: processing.minimumDurationSeconds,
        maximumDuration: processing.maximumDurationSeconds,
      };
    }
    if (stage === 'captions') return { template: 'podcast', wordsPerCue: 4 };
    if (stage === 'rendering') {
      return {
        smartReframe: true,
        aspectRatio: processing.aspectRatio,
        targetPlatform: processing.targetPlatform,
        detector: 'opencv',
        preset: 'veryfast',
        crf: 23,
        ...(await this.watermarkOptions(job.pipelineRunId, video)),
      };
    }
    if (stage === 'exports') return { bucket };
    return {};
  }

  private async persist(job: PipelineJob, response: MediaStageResponse): Promise<void> {
    if (job.stage === 'ingestion') return this.persistIngestion(job.videoId, response);
    if (job.stage === 'transcription') return this.persistTranscription(job.videoId, response);
    if (job.stage === 'segmentation') return this.persistSegments(job.videoId, response);
    if (job.stage === 'scoring') return this.persistScores(job.videoId, response);
    if (job.stage === 'clips') return this.persistClips(job.videoId, response);
    if (job.stage === 'captions') return this.persistCaptions(job.videoId, response);
    if (job.stage === 'rendering') {
      await this.prisma.clip.updateMany({ where: { videoId: job.videoId }, data: { status: 'RENDERING' } });
      return;
    }
    await this.persistExports(job.videoId, response);
  }

  private async persistIngestion(videoId: string, response: MediaStageResponse): Promise<void> {
    const metrics = response.metrics as {
      durationSeconds?: number;
      video?: { width?: number; height?: number; frameRate?: number; codec?: string };
      audio?: { codec?: string } | null;
      source?: { title?: string };
      burnedInSubtitles?: { detected?: boolean; confidence?: number };
    };
    const sourceTitle = sanitizeVideoTitle(metrics.source?.title);
    const thumbnailKey = await this.uploadArtifact(response, 'source-thumbnail', `thumbnails/videos/${videoId}/source.jpg`, 'image/jpeg');
    await this.prisma.video.update({
      where: { id: videoId },
      data: {
        ...(sourceTitle ? { title: sourceTitle } : {}),
        ...(thumbnailKey ? { thumbnailKey } : {}),
        burnedInSubtitlesDetected: Boolean(metrics.burnedInSubtitles?.detected),
        burnedInSubtitlesConfidence:
          typeof metrics.burnedInSubtitles?.confidence === 'number' ? metrics.burnedInSubtitles.confidence : undefined,
        durationMs: metrics.durationSeconds ? BigInt(Math.round(metrics.durationSeconds * 1000)) : undefined,
        width: metrics.video?.width,
        height: metrics.video?.height,
        frameRate: metrics.video?.frameRate,
        videoCodec: metrics.video?.codec,
        audioCodec: metrics.audio?.codec,
      },
    });
    try {
      await this.usage.assertCanProcessVideo(videoId);
      await this.usage.recordProcessingMinutes(videoId);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 402) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }

  private async persistTranscription(videoId: string, response: MediaStageResponse): Promise<void> {
    const value = await this.artifactJson<{
      language: string;
      confidence: number;
      durationSeconds: number;
      segments: Array<{ text: string; speaker?: string; words?: unknown[] }>;
    }>(response, 'whisperx-transcript');
    const words = value.segments.flatMap((segment) => segment.words ?? []);
    const speakers = [...new Set(value.segments.map((segment) => segment.speaker).filter(Boolean))];
    await this.prisma.transcript.upsert({
      where: { videoId },
      create: {
        videoId,
        language: value.language,
        confidence: value.confidence,
        durationMs: BigInt(Math.round(value.durationSeconds * 1000)),
        fullText: value.segments.map((segment) => segment.text).join(' '),
        words: words as Prisma.InputJsonArray,
        speakers: speakers as Prisma.InputJsonArray,
      },
      update: {
        language: value.language,
        confidence: value.confidence,
        durationMs: BigInt(Math.round(value.durationSeconds * 1000)),
        fullText: value.segments.map((segment) => segment.text).join(' '),
        words: words as Prisma.InputJsonArray,
        speakers: speakers as Prisma.InputJsonArray,
      },
    });
  }

  private async persistSegments(videoId: string, response: MediaStageResponse): Promise<void> {
    const value = await this.artifactJson<{
      segments: Array<{
        start: number;
        end: number;
        text: string;
        speakers?: string[];
        boundaryReasons?: string[];
        emotion?: { label?: string; confidence?: number };
      }>;
    }>(response, 'semantic-segments');
    await this.prisma.$transaction(async (tx) => {
      await tx.segment.deleteMany({ where: { videoId } });
      await tx.segment.createMany({
        data: value.segments.map((segment) => ({
          videoId,
          startMs: BigInt(Math.round(segment.start * 1000)),
          endMs: BigInt(Math.round(segment.end * 1000)),
          text: segment.text,
          speaker: segment.speakers?.join(', ') || null,
          topic: segment.boundaryReasons?.join(', ') || null,
          emotion: segment.emotion?.label,
          confidence: segment.emotion?.confidence ?? 0.5,
        })),
      });
    });
  }

  private async persistScores(videoId: string, response: MediaStageResponse): Promise<void> {
    const value = await this.artifactJson<{
      scores: Array<{ score: number; categories: Record<string, number>; signals?: Record<string, number> }>;
    }>(response, 'viral-scores');
    const segments = await this.prisma.segment.findMany({ where: { videoId }, orderBy: { startMs: 'asc' } });
    await this.prisma.$transaction(
      value.scores.slice(0, segments.length).map((score, index) =>
        this.prisma.viralScore.upsert({
          where: { segmentId: segments[index]!.id },
          create: scoreData(segments[index]!.id, score),
          update: scoreData(segments[index]!.id, score),
        }),
      ),
    );
  }

  private async persistClips(videoId: string, response: MediaStageResponse): Promise<void> {
    const value = await this.artifactJson<{
      clips: Array<{
        start: number;
        end: number;
        score: number;
        titleSuggestions: string[];
        reason: string;
        hook?: string;
        genre?: string;
        text: string;
        segmentIds: number[];
        thumbnail?: string;
      }>;
    }>(response, 'clip-candidates');
    const video = await this.prisma.video.findUnique({ where: { id: videoId }, select: { processingOptions: true } });
    const processing = normalizeVideoProcessingOptions(video?.processingOptions as never);
    const segments = await this.prisma.segment.findMany({ where: { videoId }, orderBy: { startMs: 'asc' } });
    await this.prisma.clip.deleteMany({ where: { videoId } });
    for (const [clipIndex, clip] of value.clips.entries()) {
      const seo = await this.seoForClip(clip);
      const thumbnailPath = clip.thumbnail ? this.resolveArtifactPath(clip.thumbnail) : undefined;
      const thumbnailKey = thumbnailPath
        ? await this.uploadLocalFile(
            thumbnailPath,
            `thumbnails/videos/${videoId}/${String(clipIndex + 1).padStart(3, '0')}-${indexKey(clip)}.jpg`,
            'image/jpeg',
          )
        : undefined;
      const created = await this.prisma.clip.create({
        data: {
          videoId,
          segmentId: segments[clip.segmentIds[0] ?? -1]?.id,
          startMs: BigInt(Math.round(clip.start * 1000)),
          endMs: BigInt(Math.round(clip.end * 1000)),
          score: clip.score,
          title: seo.titles?.[0]?.title ?? clip.titleSuggestions[0],
          titleSuggestions: (seo.titles?.map((title) => title.title) ?? clip.titleSuggestions) as Prisma.InputJsonArray,
          reason: clip.reason,
          hook: clip.hook,
          genre: clip.genre,
          sourceText: clip.text,
          aspectRatio: processing.aspectRatio,
          thumbnailKey,
        },
      });
      await this.prisma.seoMetadata.create({
        data: {
          clipId: created.id,
          titles: (seo.titles?.map((title) => title.title) ?? clip.titleSuggestions) as Prisma.InputJsonArray,
          ctrScores: (seo.titles?.map((title) => title.ctrScore) ?? []) as Prisma.InputJsonArray,
          description: seo.description ?? clip.text.slice(0, 600),
          hashtags: (seo.hashtags ?? []) as Prisma.InputJsonArray,
          keywords: (seo.keywords ?? []) as Prisma.InputJsonArray,
        },
      });
    }
  }

  private async persistCaptions(videoId: string, response: MediaStageResponse): Promise<void> {
    const value = await this.artifactJson<{
      captions: Array<{ clipId: string; srt: string; ass: string; cueCount: number; cues?: unknown[] }>;
    }>(response, 'captions-manifest');
    const clips = await this.prisma.clip.findMany({ where: { videoId }, orderBy: { createdAt: 'asc' } });
    await this.prisma.captionTrack.deleteMany({ where: { clip: { videoId } } });
    for (const caption of value.captions) {
      const index = Math.max(0, Number.parseInt(caption.clipId.replace('clip-', ''), 10) - 1);
      const clip = clips[index];
      if (!clip) continue;
      await this.prisma.captionTrack.create({
        data: {
          clipId: clip.id,
          template: 'podcast',
          language: 'pt',
          srtKey: caption.srt,
          assKey: caption.ass,
          cues: ((caption.cues?.length ? caption.cues : [{ cueCount: caption.cueCount }]) ?? []) as Prisma.InputJsonArray,
        },
      });
    }
  }

  private async seoForClip(clip: {
    titleSuggestions: string[];
    text: string;
    genre?: string;
    hook?: string;
    reason: string;
  }): Promise<{
    titles?: Array<{ title: string; ctrScore: number }>;
    description?: string;
    hashtags?: string[];
    keywords?: string[];
  }> {
    const subject = clip.titleSuggestions[0] ?? clip.genre ?? clip.hook ?? 'este corte';
    const transcript = [clip.text, clip.hook, clip.reason].filter(Boolean).join(' ').trim() || subject;
    try {
      return (await this.media.seo(transcript, { subject })) as {
        titles?: Array<{ title: string; ctrScore: number }>;
        description?: string;
        hashtags?: string[];
        keywords?: string[];
      };
    } catch {
      const title = subject.trim() || 'Corte gerado automaticamente';
      const keywords = seoKeywords([clip.text, clip.hook, clip.reason, title].join(' '));
      return {
        titles: [
          { title, ctrScore: 55 },
          { title: `${title}: veja o momento principal`, ctrScore: 50 },
        ],
        description: (clip.text || clip.reason || title).slice(0, 600),
        hashtags: keywords.length ? keywords.map((keyword) => `#${keyword}`) : ['#PicaShorts', '#Cortes', '#Video'],
        keywords,
      };
    }
  }

  private async persistExports(videoId: string, response: MediaStageResponse): Promise<void> {
    const metrics = response.metrics as {
      storage?: Array<{ key: string; bytes: number; mediaType: string }>;
    };
    const value = metrics.storage
      ? { storage: metrics.storage }
      : await this.artifactJson<{
          storage: Array<{ key: string; bytes: number; mediaType: string }>;
        }>(response, 'export-manifest');
    const clips = await this.prisma.clip.findMany({ where: { videoId }, orderBy: { createdAt: 'asc' }, include: { captions: true } });
    for (const stored of value.storage) {
      const filename = stored.key.split('/').at(-1) ?? '';
      const match = /^clip-(\d{3})\.(mp4|srt|ass)$/.exec(filename);
      if (!match) continue;
      const clip = clips[Number(match[1]) - 1];
      if (!clip) continue;
      if (match[2] === 'mp4') {
        const queued = await this.prisma.export.findFirst({
          where: { clipId: clip.id, format: 'MP4', aspectRatio: clip.aspectRatio, status: { in: ['QUEUED', 'PROCESSING'] } },
          orderBy: { createdAt: 'desc' },
        });
        const data = {
          format: 'MP4',
          aspectRatio: clip.aspectRatio,
          storageKey: stored.key,
          sizeBytes: BigInt(stored.bytes),
          status: 'READY' as const,
        };
        if (queued) {
          await this.prisma.export.update({
            where: { id: queued.id },
            data,
          });
        } else {
          await this.prisma.export.create({
            data: {
              clipId: clip.id,
              ...data,
            },
          });
        }
        await this.prisma.clip.update({ where: { id: clip.id }, data: { status: 'READY' } });
      } else if (clip.captions[0]) {
        await this.prisma.captionTrack.update({
          where: { id: clip.captions[0].id },
          data: match[2] === 'srt' ? { srtKey: stored.key } : { assKey: stored.key },
        });
      }
    }
  }

  private async artifactJson<T>(response: MediaStageResponse, kind: string): Promise<T> {
    const artifact = response.artifacts.find((value) => value.kind === kind);
    if (!artifact) throw Object.assign(new Error(`Media worker did not produce ${kind}`), { code: 'ARTIFACT_MISSING' });
    return JSON.parse(await readFile(this.resolveArtifactPath(artifact.path), 'utf8')) as T;
  }

  private async uploadArtifact(
    response: MediaStageResponse,
    kind: string,
    key: string,
    contentType: string,
  ): Promise<string | undefined> {
    const artifact = response.artifacts.find((value) => value.kind === kind);
    if (!artifact) return undefined;
    return this.uploadLocalFile(this.resolveArtifactPath(artifact.path), key, contentType);
  }

  private async uploadLocalFile(path: string, key: string, contentType: string): Promise<string> {
    await this.storage.upload(key, createReadStream(path), contentType);
    return key;
  }

  private resolveArtifactPath(path: string): string {
    const resolved = resolve(path);
    if (resolved !== this.dataRoot && !resolved.startsWith(`${this.dataRoot}${sep}`)) {
      throw Object.assign(new Error('Media worker artifact path is outside the shared data directory'), {
        code: 'ARTIFACT_PATH_REJECTED',
      });
    }
    return resolved;
  }

  private async watermarkOptions(
    pipelineRunId: string,
    video?: {
      workspace?: {
        plan: Parameters<typeof limitsFor>[0];
        brandKits: Array<{ name: string; logoKey: string | null; watermark: Prisma.JsonValue | null }>;
      } | null;
    },
  ): Promise<Record<string, unknown>> {
    const workspace = video?.workspace;
    if (!workspace || !limitsFor(workspace.plan).watermark) return {};
    const kit = workspace.brandKits[0];
    const config = (kit?.watermark && typeof kit.watermark === 'object' && !Array.isArray(kit.watermark)
      ? kit.watermark
      : {}) as Record<string, unknown>;
    const position = typeof config.position === 'string' ? config.position : 'W-w-32:H-h-32';
    const opacity = typeof config.opacity === 'number' ? Math.max(0.1, Math.min(1, config.opacity)) : 0.75;
    const logoWidth = typeof config.size === 'number' ? Math.max(48, Math.min(420, config.size)) : 180;
    if (kit?.logoKey) {
      try {
        const watermarkPath = await this.materializeBrandLogo(pipelineRunId, kit.logoKey);
        return {
          watermarkPath,
          watermarkPosition: position,
          watermarkOpacity: opacity,
          watermarkLogoWidth: logoWidth,
        };
      } catch {
        // Fall back to text watermark if the configured object is temporarily unavailable.
      }
    }
    const text = typeof config.text === 'string' && config.text.trim() ? config.text.trim() : kit?.name || 'PicaShorts';
    return {
      watermarkText: text,
      watermarkTextPosition: textWatermarkPosition(position),
      watermarkTextOpacity: opacity,
    };
  }

  private async materializeBrandLogo(pipelineRunId: string, logoKey: string): Promise<string> {
    const extension = allowedLogoExtension(extname(logoKey));
    const destination = resolve(this.dataRoot, pipelineRunId, 'brand', `watermark${extension}`);
    if (destination !== this.dataRoot && !destination.startsWith(`${this.dataRoot}${sep}`)) {
      throw Object.assign(new Error('Brand logo path is outside the shared data directory'), { code: 'BRAND_LOGO_PATH_REJECTED' });
    }
    await mkdir(dirname(destination), { recursive: true });
    const signedUrl = await this.storage.downloadUrl(logoKey, 300);
    const response = await fetch(signedUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw Object.assign(new Error('Unable to download brand logo'), { code: 'BRAND_LOGO_DOWNLOAD_FAILED' });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) {
      throw Object.assign(new Error('Brand logo exceeds the 8 MiB render limit'), { code: 'BRAND_LOGO_TOO_LARGE' });
    }
    await writeFile(destination, bytes);
    return destination;
  }
}

function sanitizeVideoTitle(value?: string): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, ' ');
  return normalized ? normalized.slice(0, 180) : undefined;
}

function scoreData(
  segmentId: string,
  score: { score: number; categories: Record<string, number>; signals?: Record<string, number> },
) {
  const category = score.categories;
  return {
    segmentId,
    curiosity: category.curiosity ?? 0,
    authority: category.authority ?? 0,
    controversy: category.controversy ?? 0,
    emotion: category.emotion ?? 0,
    business: category.business ?? 0,
    entertainment: category.entertainment ?? 0,
    educational: category.educational ?? 0,
    financial: category.financial ?? 0,
    finalScore: score.score,
    explanation: JSON.stringify(score.signals ?? {}),
  };
}

function allowedLogoExtension(value: string): '.png' | '.jpg' | '.jpeg' | '.webp' {
  const normalized = value.toLowerCase();
  if (normalized === '.jpg') return '.jpg';
  if (normalized === '.jpeg') return '.jpeg';
  if (normalized === '.webp') return '.webp';
  if (normalized === '.png') return '.png';
  return '.png';
}

function textWatermarkPosition(value: string): string {
  if (value === '32:32') return value;
  if (value === 'W-w-32:32') return 'W-tw-32:32';
  if (value === '32:H-h-32') return '32:H-th-32';
  if (value === 'W-w-32:H-h-32') return 'W-tw-32:H-th-32';
  return 'W-tw-32:H-th-32';
}

function indexKey(clip: { start: number; end: number }): string {
  return `${Math.round(clip.start * 1000)}-${Math.round(clip.end * 1000)}`;
}

function seoKeywords(value: string): string[] {
  const stopwords = new Set(['para', 'com', 'que', 'uma', 'por', 'the', 'and', 'you', 'thank']);
  const seen = new Set<string>();
  const words = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-zA-Z0-9]{3,}/g) ?? [];
  for (const word of words) {
    const normalized = word.toLowerCase();
    if (stopwords.has(normalized)) continue;
    seen.add(normalized.charAt(0).toUpperCase() + normalized.slice(1));
    if (seen.size >= 8) break;
  }
  return [...seen];
}
