import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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

@Injectable()
export class MediaStageProcessor {
  private readonly dataRoot: string;
  private readonly diarizationEnabled: boolean;
  private readonly transcriptionBatchSize: number;
  private readonly ffmpegPreset: string;
  private readonly ffmpegCrf: number;
  private readonly renderMaxSourceShortSide: number;
  private readonly compositionV1Enabled: boolean;
  private readonly compositionV1RolloutPercent: number;
  private readonly mediaAccelerator: 'cpu' | 'cuda';
  private readonly aiExecutionMode: 'local' | 'hybrid';
  private readonly sttProvider: 'whisperx' | 'deepgram';
  private readonly gpuProvider: 'none' | 'runpod';
  private readonly aiCostLimitUsdPerSourceHour: number;
  private readonly finalMaxShortSide: number;

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
    this.ffmpegPreset = config.get('FFMPEG_PRESET', { infer: true });
    this.ffmpegCrf = config.get('FFMPEG_CRF', { infer: true });
    this.renderMaxSourceShortSide = config.get('RENDER_MAX_SOURCE_SHORT_SIDE', { infer: true });
    this.compositionV1Enabled = config.get('COMPOSITION_V1_ENABLED', { infer: true });
    this.compositionV1RolloutPercent = config.get('COMPOSITION_V1_ROLLOUT_PERCENT', { infer: true }) ?? 100;
    this.mediaAccelerator = config.get('MEDIA_ACCELERATOR', { infer: true });
    this.aiExecutionMode = config.get('AI_EXECUTION_MODE', { infer: true });
    this.sttProvider = config.get('STT_PROVIDER', { infer: true });
    this.gpuProvider = config.get('GPU_PROVIDER', { infer: true });
    this.aiCostLimitUsdPerSourceHour = config.get('AI_COST_LIMIT_USD_PER_SOURCE_HOUR', { infer: true });
    this.finalMaxShortSide = config.get('FINAL_MAX_SHORT_SIDE', { infer: true });
  }

  async process(job: PipelineJob): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: job.videoId },
      include: {
        workspace: {
          select: {
            brandKits: {
              orderBy: { createdAt: 'asc' },
              take: 1,
              select: { logoKey: true, watermark: true },
            },
          },
        },
      },
    });
    if (!video) throw new NotFoundException('Video not found for pipeline stage');
    if (!video.storageBucket) throw new UnrecoverableError('Video storage bucket is required for media processing');
    const processingOptions = normalizeVideoProcessingOptions(video.processingOptions as never);
    const options = await this.options(job, video.storageBucket, processingOptions, video);
    await this.markExportProcessing(job);
    const remoteSource = this.usesRemoteSource(job.stage);
    const sourceUri = remoteSource
      ? await this.storage.downloadUrl(video.storageKey, 3600)
      : job.stage === 'ingestion' ? video.sourceUrl ?? undefined : undefined;
    const sourceStorage = job.stage === 'ingestion' && video.sourceUrl
      ? undefined
      : { bucket: video.storageBucket, key: video.storageKey };
    let response: MediaStageResponse;
    try {
      response = await this.media.execute(
        job,
        sourceStorage,
        options,
        sourceUri,
      );
    } catch (error) {
      const terminal = asUnrecoverableMediaError(error);
      if (terminal) throw terminal;
      throw error;
    }
    await this.persist(job, response, video);
    await this.recordProviderUsage(video.workspaceId, job.videoId, response);
  }

  private usesRemoteSource(stage: string): boolean {
    if (this.aiExecutionMode !== 'hybrid') return false;
    if (stage === 'transcription') return this.sttProvider === 'deepgram';
    return stage === 'rendering' && this.gpuProvider === 'runpod';
  }

  private async options(
    job: PipelineJob,
    bucket: string,
    processing: ReturnType<typeof normalizeVideoProcessingOptions>,
    video?: {
      checksumSha256?: string | null;
      storageEtag?: string | null;
      workspace?: {
        brandKits: Array<{ logoKey: string | null; watermark: Prisma.JsonValue | null }>;
      } | null;
    },
  ): Promise<Record<string, unknown>> {
    const stage = job.stage;
    const compositionEnabled = this.compositionEnabledFor(job.videoId);
    const providerBudget = await this.providerBudget(job.videoId);
    if (stage === 'transcription') {
      return { diarize: this.diarizationEnabled, batchSize: this.transcriptionBatchSize, ...providerBudget };
    }
    if (stage === 'clips') {
      return {
        count: processing.clipCount,
        minimumDuration: processing.minimumDurationSeconds,
        maximumDuration: processing.maximumDurationSeconds,
      };
    }
    if (stage === 'captions') return { template: 'podcast', wordsPerCue: 6 };
    if (stage === 'scoring') return providerBudget;
    if (stage === 'composition') {
      const analysisFps = Number(providerBudget.analysisFps ?? (this.mediaAccelerator === 'cuda' ? 10 : 2));
      return {
        enabled: compositionEnabled,
        aspectRatio: processing.aspectRatio,
        detector: this.mediaAccelerator === 'cuda' ? 'yolo' : 'opencv',
        sampleSeconds: 1 / Math.max(1, analysisFps),
        analysisFps,
        minimumSpeakerConfidence: 0.65,
        focusSwitchDelaySeconds: 0.6,
        analysisBudgetRatio: 1,
        remote: this.aiExecutionMode === 'hybrid' && this.gpuProvider === 'runpod',
        ...this.sourceIntegrityOptions(video),
        ...providerBudget,
      };
    }
    if (stage === 'rendering') {
      if (!job.clipId) return this.batchRenderOptions(job, bucket, processing, video, providerBudget);
      const render = await this.clipRenderContext(job);
      const remote = this.aiExecutionMode === 'hybrid' && this.gpuProvider === 'runpod';
      const outputKey = `exports/${job.videoId}/${job.exportId}/clip-${String(render.clipIndex + 1).padStart(3, '0')}.mp4`;
      return {
        smartReframe: true,
        compositionV1: compositionEnabled,
        aspectRatio: render.aspectRatio,
        targetPlatform: processing.targetPlatform,
        detector: 'opencv',
        preset: this.ffmpegPreset,
        crf: render.purpose === 'PREVIEW' ? 24 : this.ffmpegCrf,
        cq: 19,
        preserveSourceQuality: true,
        maxSourceShortSide: render.purpose === 'PREVIEW' ? 540 : Math.min(this.finalMaxShortSide, this.renderMaxSourceShortSide),
        purpose: render.purpose,
        clipIndex: render.clipIndex,
        clipOverride: render.clipOverride,
        ...(render.captionOverride ? { captionOverride: render.captionOverride } : {}),
        clipId: job.clipId,
        exportId: job.exportId,
        sourcePipelineRunId: job.sourcePipelineRunId,
        renderFingerprint: job.renderFingerprint,
        regenerateComposition: job.regenerateComposition ?? false,
        ...(await this.watermarkOptions(job.pipelineRunId, video, remote)),
        remote,
        ...(remote
          ? {
              batchOutputs: [{
                clipIndex: render.clipIndex,
                clipId: job.clipId,
                exportId: job.exportId,
                bucket,
                key: outputKey,
                uploadUrl: await this.storage.uploadUrl(outputKey, 'video/mp4', 3600),
              }],
            }
          : {}),
        ...this.sourceIntegrityOptions(video),
        ...providerBudget,
      };
    }
    if (stage === 'exports') {
      if (!job.clipId) return this.batchExportOptions(job, bucket);
      const render = await this.clipRenderContext(job);
      return {
        bucket,
        prefix: `exports/${job.videoId}/${job.exportId}`,
        clipIndex: render.clipIndex,
        clipId: job.clipId,
        exportId: job.exportId,
        sourcePipelineRunId: job.sourcePipelineRunId,
        renderFingerprint: job.renderFingerprint,
        purpose: render.purpose,
      };
    }
    return {};
  }

  private async batchRenderOptions(
    job: PipelineJob,
    bucket: string,
    processing: ReturnType<typeof normalizeVideoProcessingOptions>,
    video: {
      checksumSha256?: string | null;
      storageEtag?: string | null;
      workspace?: {
        brandKits: Array<{ logoKey: string | null; watermark: Prisma.JsonValue | null }>;
      } | null;
    } | undefined,
    providerBudget: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const remote = this.aiExecutionMode === 'hybrid' && this.gpuProvider === 'runpod';
    const clips = await this.prisma.clip.findMany({
      where: { videoId: job.videoId },
      orderBy: { createdAt: 'asc' },
      include: {
        captions: { orderBy: { createdAt: 'asc' }, take: 1 },
        composition: true,
      },
    });
    if (!clips.length) throw new UnrecoverableError('Automatic rendering requires at least one clip');
    const batchOutputs = [];
    for (const [index, clip] of clips.entries()) {
      const fingerprint = automaticRenderFingerprint({
        clipId: clip.id,
        startMs: clip.startMs.toString(),
        endMs: clip.endMs.toString(),
        aspectRatio: clip.aspectRatio,
        captionUpdatedAt: clip.captions[0]?.updatedAt?.toISOString(),
        compositionUpdatedAt: clip.composition?.updatedAt?.toISOString(),
        compositionVersion: clip.composition?.version,
        maxSourceShortSide: Math.min(this.finalMaxShortSide, this.renderMaxSourceShortSide),
        preset: this.ffmpegPreset,
        crf: this.ffmpegCrf,
        accelerator: this.mediaAccelerator,
      });
      let exportJob = await this.prisma.export.findFirst({
        where: {
          clipId: clip.id,
          purpose: 'FINAL',
          renderFingerprint: fingerprint,
          OR: [
            { status: 'READY' },
            { sourcePipelineRunId: job.pipelineRunId, status: { in: ['QUEUED', 'PROCESSING'] } },
          ],
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!exportJob) {
        exportJob = await this.prisma.export.create({
          data: {
            id: randomUUID(),
            clipId: clip.id,
            format: 'MP4',
            purpose: 'FINAL',
            aspectRatio: clip.aspectRatio,
            renderFingerprint: fingerprint,
            sourcePipelineRunId: job.pipelineRunId,
            status: 'QUEUED',
          },
        });
      }
      const key = `exports/${job.videoId}/${exportJob.id}/clip-${String(index + 1).padStart(3, '0')}.mp4`;
      const uploadUrl = !remote || (exportJob.status === 'READY' && exportJob.storageKey)
        ? undefined
        : await this.storage.uploadUrl(key, 'video/mp4', 3600);
      batchOutputs.push({
        clipIndex: index,
        clipId: clip.id,
        exportId: exportJob.id,
        bucket,
        key,
        ...(uploadUrl ? { uploadUrl } : {}),
        ready: exportJob.status === 'READY' && Boolean(exportJob.storageKey),
      });
    }
    await this.prisma.clip.updateMany({
      where: { videoId: job.videoId, status: { in: ['SUGGESTED', 'APPROVED', 'FAILED'] } },
      data: { status: 'RENDERING' },
    });
    await this.prisma.export.updateMany({
      where: { id: { in: batchOutputs.filter((item) => !item.ready).map((item) => item.exportId) } },
      data: { status: 'PROCESSING', errorCode: null },
    });
    return {
      smartReframe: true,
      compositionV1: true,
      aspectRatio: processing.aspectRatio,
      targetPlatform: processing.targetPlatform,
      detector: this.gpuProvider === 'runpod' ? 'yolo' : 'opencv',
      preset: this.ffmpegPreset,
      crf: this.ffmpegCrf,
      cq: 19,
      preserveSourceQuality: true,
      maxSourceShortSide: Math.min(this.finalMaxShortSide, this.renderMaxSourceShortSide),
      purpose: 'FINAL',
      clipIndexes: clips.map((_, index) => index),
      sourcePipelineRunId: job.pipelineRunId,
      batchOutputs,
      remote,
      ...this.sourceIntegrityOptions(video),
      ...(await this.watermarkOptions(
        job.pipelineRunId,
        video,
        remote,
      )),
      ...providerBudget,
    };
  }

  private async batchExportOptions(job: PipelineJob, bucket: string): Promise<Record<string, unknown>> {
    const clips = await this.prisma.clip.findMany({ where: { videoId: job.videoId }, orderBy: { createdAt: 'asc' } });
    const exports = await this.prisma.export.findMany({
      where: { sourcePipelineRunId: job.pipelineRunId, purpose: 'FINAL' },
      orderBy: { createdAt: 'asc' },
    });
    const byClip = new Map(exports.map((item) => [item.clipId, item]));
    const batchOutputs = clips.flatMap((clip, index) => {
      const item = byClip.get(clip.id);
      if (!item) return [];
      const prefix = `exports/${job.videoId}/${item.id}`;
      return [{
        clipIndex: index,
        clipId: clip.id,
        exportId: item.id,
        key: item.storageKey ?? `${prefix}/clip-${String(index + 1).padStart(3, '0')}.mp4`,
        prefix,
      }];
    });
    return {
      batch: true,
      bucket,
      purpose: 'FINAL',
      clipIndexes: clips.map((_, index) => index),
      sourcePipelineRunId: job.pipelineRunId,
      batchOutputs,
    };
  }

  private async providerBudget(videoId: string): Promise<Record<string, unknown>> {
    if (this.aiExecutionMode !== 'hybrid') return {};
    const [video, usage] = await Promise.all([
      this.prisma.video.findUnique({ where: { id: videoId }, select: { durationMs: true } }),
      this.prisma.usageEvent.aggregate({
        where: { videoId, type: { in: ['ai.deepgram', 'ai.openrouter', 'gpu.runpod'] } },
        _sum: { costCents: true },
      }),
    ]);
    const sourceDurationSeconds = Number(video?.durationMs ?? 0n) / 1000;
    const costLimitUsd = sourceDurationSeconds / 3600 * this.aiCostLimitUsdPerSourceHour;
    const spentUsd = Number(usage._sum.costCents ?? 0) / 100;
    const remainingUsd = Math.max(0, costLimitUsd - spentUsd);
    const remainingRatio = costLimitUsd > 0 ? remainingUsd / costLimitUsd : 0;
    return {
      sourceDurationSeconds,
      costLimitUsd: roundMoney(costLimitUsd),
      costRemainingUsd: roundMoney(remainingUsd),
      visualQaEnabled: remainingRatio >= 0.5,
      analysisFps: remainingRatio >= 0.25 ? 10 : 6,
    };
  }

  private async recordProviderUsage(workspaceId: string | null, videoId: string, response: MediaStageResponse): Promise<void> {
    if (!workspaceId) return;
    const metrics = response.metrics as { providerUsage?: unknown };
    if (!Array.isArray(metrics.providerUsage)) return;
    for (const raw of metrics.providerUsage) {
      if (!raw || typeof raw !== 'object') continue;
      const value = raw as Record<string, unknown>;
      const provider = typeof value.provider === 'string' ? value.provider.toLowerCase() : '';
      const requestId = typeof value.requestId === 'string' ? value.requestId : '';
      if (!['deepgram', 'openrouter', 'runpod'].includes(provider) || !requestId) continue;
      const rawQuantity = Number(value.quantity ?? 0);
      const rawCostUsd = Number(value.costUsd ?? 0);
      const quantity = Number.isFinite(rawQuantity) ? Math.max(0, rawQuantity) : 0;
      const costUsd = Number.isFinite(rawCostUsd) ? Math.max(0, rawCostUsd) : 0;
      const idempotencyKey = `${provider}:${requestId}`.slice(0, 160);
      await this.prisma.usageEvent.upsert({
        where: { idempotencyKey },
        create: {
          idempotencyKey,
          workspaceId,
          videoId,
          type: provider === 'runpod' ? 'gpu.runpod' : `ai.${provider}`,
          quantity: new Prisma.Decimal(quantity),
          unit: typeof value.unit === 'string' ? value.unit : 'request',
          costCents: costUsd > 0 ? Math.max(1, Math.ceil(costUsd * 100)) : 0,
          metadata: {
            costUsd: roundMoney(costUsd),
            latencyMs: Number(value.latencyMs ?? 0),
            model: String(value.model ?? ''),
          },
        },
        update: {},
      });
    }
  }

  private compositionEnabledFor(videoId: string): boolean {
    if (!this.compositionV1Enabled || this.compositionV1RolloutPercent <= 0) return false;
    if (this.compositionV1RolloutPercent >= 100) return true;
    let hash = 2_166_136_261;
    for (const character of videoId) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16_777_619);
    }
    return (hash >>> 0) % 100 < this.compositionV1RolloutPercent;
  }

  private sourceIntegrityOptions(video?: { checksumSha256?: string | null; storageEtag?: string | null }): Record<string, string> {
    if (video?.checksumSha256 && /^[a-f0-9]{64}$/i.test(video.checksumSha256)) {
      return { sourceSha256: video.checksumSha256.toLowerCase() };
    }
    return video?.storageEtag ? { sourceEtag: video.storageEtag } : {};
  }

  private async persist(
    job: PipelineJob,
    response: MediaStageResponse,
    video: {
      sourceUrl?: string | null;
      storageKey: string;
      mimeType?: string | null;
    },
  ): Promise<void> {
    if (job.stage === 'ingestion') return this.persistIngestion(job.videoId, response, video);
    if (job.stage === 'transcription') return this.persistTranscription(job.videoId, response);
    if (job.stage === 'segmentation') return this.persistSegments(job.videoId, response);
    if (job.stage === 'scoring') return this.persistScores(job.videoId, response);
    if (job.stage === 'clips') return this.persistClips(job.videoId, response);
    if (job.stage === 'captions') return this.persistCaptions(job.videoId, response);
    if (job.stage === 'composition') return this.persistComposition(job.videoId, response);
    if (job.stage === 'rendering') {
      await this.verifyStoredObjects(providerStorage(response));
      if (response.artifacts.some((item) => item.kind === 'composition-manifest')) {
        await this.persistComposition(job.videoId, response);
      }
      if (!job.clipId) {
        await this.persistQualityStatus(job.videoId, response);
        return;
      }
      const finalExport = await this.prisma.export.findFirst({
        where: { id: job.exportId, clipId: job.clipId, purpose: 'FINAL' },
        select: { id: true },
      });
      if (finalExport) {
        await this.prisma.clip.update({ where: { id: job.clipId }, data: { status: 'RENDERING' } });
      }
      await this.persistQualityStatus(job.videoId, response);
      return;
    }
    await this.persistExports(job, response);
  }

  private async markExportProcessing(job: PipelineJob): Promise<void> {
    if (!job.exportId || (job.stage !== 'rendering' && job.stage !== 'exports')) return;
    await this.prisma.export.updateMany({
      where: { id: job.exportId, status: { in: ['QUEUED', 'PROCESSING'] } },
      data: { status: 'PROCESSING', errorCode: null },
    });
  }

  private async clipRenderContext(job: PipelineJob): Promise<{
    clipIndex: number;
    aspectRatio: string;
    purpose: 'PREVIEW' | 'FINAL';
    clipOverride: { clipIndex: number; start: number; end: number };
    captionOverride?: { template: string; cues: Prisma.JsonValue; style: Prisma.JsonValue | null };
  }> {
    if (!job.clipId || !job.exportId || !job.sourcePipelineRunId || !job.renderFingerprint) {
      throw new UnrecoverableError('On-demand render jobs require clipId, exportId, sourcePipelineRunId and renderFingerprint');
    }
    const [clips, exportJob] = await Promise.all([
      this.prisma.clip.findMany({
        where: { videoId: job.videoId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          aspectRatio: true,
          startMs: true,
          endMs: true,
          captions: {
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: { template: true, cues: true, editedCues: true, style: true },
          },
        },
      }),
      this.prisma.export.findFirst({
        where: { id: job.exportId, clipId: job.clipId },
        select: { aspectRatio: true, renderFingerprint: true, purpose: true },
      }),
    ]);
    const clipIndex = clips.findIndex((clip) => clip.id === job.clipId);
    if (clipIndex < 0 || !exportJob) throw new UnrecoverableError('On-demand render job references an unavailable clip/export');
    if (exportJob.renderFingerprint && exportJob.renderFingerprint !== job.renderFingerprint) {
      throw new UnrecoverableError('On-demand render job fingerprint no longer matches the export request');
    }
    const clip = clips[clipIndex]!;
    const caption = clip.captions[0];
    return {
      clipIndex,
      aspectRatio: exportJob.aspectRatio ?? clip.aspectRatio,
      purpose: exportJob.purpose,
      clipOverride: {
        clipIndex,
        start: Number(clip.startMs) / 1000,
        end: Number(clip.endMs) / 1000,
      },
      ...(caption
        ? {
            captionOverride: {
              template: caption.template,
              cues: caption.editedCues ?? caption.cues,
              style: caption.style,
            },
          }
        : {}),
    };
  }

  private async persistIngestion(
    videoId: string,
    response: MediaStageResponse,
    video: {
      sourceUrl?: string | null;
      storageKey: string;
      mimeType?: string | null;
    },
  ): Promise<void> {
    const metrics = response.metrics as {
      durationSeconds?: number;
      video?: { width?: number; height?: number; frameRate?: number; codec?: string };
      audio?: { codec?: string } | null;
      source?: { title?: string };
      burnedInSubtitles?: { detected?: boolean; confidence?: number };
    };
    const sourceTitle = sanitizeVideoTitle(metrics.source?.title);
    const thumbnailKey = await this.uploadArtifact(response, 'source-thumbnail', `thumbnails/videos/${videoId}/source.jpg`, 'image/jpeg');
    if (video.sourceUrl) {
      await this.uploadArtifact(response, 'source-video', video.storageKey, this.artifactMediaType(response, 'source-video') ?? video.mimeType ?? 'video/mp4');
    }
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
        throw Object.assign(new UnrecoverableError(error.message), { code: 'PLAN_LIMIT_EXCEEDED' });
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

  private async persistComposition(videoId: string, response: MediaStageResponse): Promise<void> {
    const value = await this.artifactJson<{
      compositions: Array<{
        clipId: string;
        version: string;
        diagnostics?: unknown;
        [key: string]: unknown;
      }>;
    }>(response, 'composition-manifest');
    const clips = await this.prisma.clip.findMany({ where: { videoId }, orderBy: { createdAt: 'asc' } });
    for (const composition of value.compositions) {
      const index = Math.max(0, Number.parseInt(composition.clipId.replace('clip-', ''), 10) - 1);
      const clip = clips[index];
      if (!clip) continue;
      const diagnostics = composition.diagnostics ?? {};
      await this.prisma.clipComposition.upsert({
        where: { clipId: clip.id },
        create: {
          clipId: clip.id,
          version: composition.version,
          plan: composition as Prisma.InputJsonObject,
          diagnostics: diagnostics as Prisma.InputJsonValue,
        },
        update: {
          version: composition.version,
          plan: composition as Prisma.InputJsonObject,
          diagnostics: diagnostics as Prisma.InputJsonValue,
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

  private async persistExports(job: PipelineJob, response: MediaStageResponse): Promise<void> {
    const metrics = response.metrics as {
      storage?: StoredMediaObject[];
    };
    const value = metrics.storage
      ? { storage: metrics.storage }
      : await this.artifactJson<{
          storage: StoredMediaObject[];
        }>(response, 'export-manifest');
    await this.verifyStoredObjects(value.storage);
    if (!job.clipId || !job.exportId) {
      return this.persistBatchExports(job, value.storage);
    }
    const [clips, exportJob] = await Promise.all([
      this.prisma.clip.findMany({ where: { videoId: job.videoId }, orderBy: { createdAt: 'asc' }, include: { captions: true } }),
      this.prisma.export.findUnique({ where: { id: job.exportId }, select: { purpose: true } }),
    ]);
    if (!exportJob) throw new UnrecoverableError('On-demand export job references an unavailable export');
    const targetClip = clips.find((clip) => clip.id === job.clipId);
    if (!targetClip) throw new UnrecoverableError('On-demand export job references an unavailable clip');
    let storedMp4 = false;
    let storedSrt = false;
    let storedAss = false;
    for (const stored of value.storage) {
      const filename = stored.key.split('/').at(-1) ?? '';
      const match = /^clip-(\d{3})\.(mp4|srt|ass)$/.exec(filename);
      if (!match) continue;
      const clip = clips[Number(match[1]) - 1];
      if (clip?.id !== targetClip.id) continue;
      if (!clip) continue;
      if (match[2] === 'mp4') {
        const data = {
          format: 'MP4',
          aspectRatio: clip.aspectRatio,
          storageKey: stored.key,
          sizeBytes: BigInt(stored.bytes),
          status: 'READY' as const,
        };
        await this.prisma.export.update({
          where: { id: job.exportId },
          data,
        });
        if (exportJob.purpose === 'FINAL' && clip.status !== 'REVIEW_REQUIRED') {
          await this.prisma.clip.update({ where: { id: clip.id }, data: { status: 'READY' } });
        }
        storedMp4 = true;
      } else if (clip.captions[0] && exportJob.purpose === 'FINAL') {
        if (match[2] === 'srt') storedSrt = true;
        if (match[2] === 'ass') storedAss = true;
        await this.prisma.captionTrack.update({
          where: { id: clip.captions[0].id },
          data: match[2] === 'srt' ? { srtKey: stored.key } : { assKey: stored.key },
        });
      }
    }
    if (exportJob.purpose === 'FINAL' && targetClip.captions[0] && (!storedSrt || !storedAss)) {
      await this.prisma.captionTrack.update({
        where: { id: targetClip.captions[0].id },
        data: {
          ...(!storedSrt ? { srtKey: null } : {}),
          ...(!storedAss ? { assKey: null } : {}),
        },
      });
    }
    if (!storedMp4) throw new UnrecoverableError('On-demand export did not upload the requested MP4');
  }

  private async persistBatchExports(job: PipelineJob, storage: StoredMediaObject[]): Promise<void> {
    const exportIds = [...new Set(storage.map((item) => item.exportId).filter((value): value is string => Boolean(value)))];
    const exports = await this.prisma.export.findMany({
      where: {
        id: { in: exportIds },
        sourcePipelineRunId: job.pipelineRunId,
        clip: { videoId: job.videoId },
      },
      include: {
        clip: {
          include: { captions: { orderBy: { createdAt: 'asc' }, take: 1 } },
        },
      },
    });
    const byId = new Map(exports.map((item) => [item.id, item]));
    const completed = new Set<string>();
    for (const stored of storage) {
      if (!stored.exportId) continue;
      const exportJob = byId.get(stored.exportId);
      if (!exportJob) continue;
      const extension = stored.key.split('.').at(-1)?.toLowerCase();
      if (extension === 'mp4') {
        await this.prisma.export.update({
          where: { id: exportJob.id },
          data: {
            format: 'MP4',
            aspectRatio: exportJob.clip.aspectRatio,
            storageKey: stored.key,
            sizeBytes: BigInt(stored.bytes),
            status: 'READY',
            errorCode: null,
          },
        });
        if (exportJob.clip.status !== 'REVIEW_REQUIRED') {
          await this.prisma.clip.update({ where: { id: exportJob.clipId }, data: { status: 'READY' } });
        }
        completed.add(exportJob.id);
      } else if (extension === 'srt' || extension === 'ass') {
        const caption = exportJob.clip.captions[0];
        if (caption) {
          await this.prisma.captionTrack.update({
            where: { id: caption.id },
            data: extension === 'srt' ? { srtKey: stored.key } : { assKey: stored.key },
          });
        }
      }
    }
    const missing = exports.filter((item) => item.status !== 'READY' && !completed.has(item.id));
    if (missing.length) {
      throw new UnrecoverableError(`Automatic export is missing ${missing.length} rendered MP4 file(s)`);
    }
  }

  private async verifyStoredObjects(values: StoredMediaObject[]): Promise<void> {
    for (const value of values) {
      if (!value.key || !Number.isSafeInteger(value.bytes) || value.bytes <= 0) {
        throw new UnrecoverableError('Remote media output has invalid storage metadata');
      }
      const metadata = await this.storage.metadata(value.key);
      if (metadata.bytes !== BigInt(value.bytes)) {
        throw new UnrecoverableError('Remote media output size does not match object storage');
      }
    }
  }

  private async persistQualityStatus(videoId: string, response: MediaStageResponse): Promise<void> {
    const metrics = response.metrics as { quality?: { failedClipIds?: unknown } | null };
    const failed = metrics.quality?.failedClipIds;
    if (!Array.isArray(failed) || !failed.length) return;
    const indexes = new Set(
      failed
        .map((value) => /^clip-(\d{3})$/.exec(String(value)))
        .filter((value): value is RegExpExecArray => Boolean(value))
        .map((value) => Number(value[1]) - 1),
    );
    const clips = await this.prisma.clip.findMany({
      where: { videoId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const ids = clips.filter((_, index) => indexes.has(index)).map((clip) => clip.id);
    if (ids.length) {
      await this.prisma.clip.updateMany({
        where: { id: { in: ids } },
        data: { status: 'REVIEW_REQUIRED' },
      });
    }
  }

  private async artifactJson<T>(response: MediaStageResponse, kind: string): Promise<T> {
    const artifact = response.artifacts.find((value) => value.kind === kind);
    if (!artifact) throw Object.assign(new Error(`Media worker did not produce ${kind}`), { code: 'ARTIFACT_MISSING' });
    if (artifact.location?.type === 'object') {
      const url = await this.storage.downloadUrl(artifact.location.key, 300);
      const remote = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!remote.ok) {
        throw Object.assign(new Error(`Unable to download media artifact ${kind}`), { code: 'ARTIFACT_DOWNLOAD_FAILED' });
      }
      return JSON.parse(await remote.text()) as T;
    }
    return JSON.parse(await readFile(this.resolveArtifactPath(localArtifactPath(artifact)), 'utf8')) as T;
  }

  private async uploadArtifact(
    response: MediaStageResponse,
    kind: string,
    key: string,
    contentType: string,
  ): Promise<string | undefined> {
    const artifact = response.artifacts.find((value) => value.kind === kind);
    if (!artifact) return undefined;
    if (artifact.location?.type === 'object') return artifact.location.key;
    return this.uploadLocalFile(this.resolveArtifactPath(localArtifactPath(artifact)), key, contentType);
  }

  private artifactMediaType(response: MediaStageResponse, kind: string): string | undefined {
    const artifact = response.artifacts.find((value) => value.kind === kind);
    return artifact?.media_type;
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
        brandKits: Array<{ logoKey: string | null; watermark: Prisma.JsonValue | null }>;
      } | null;
    },
    remote = false,
  ): Promise<Record<string, unknown>> {
    const workspace = video?.workspace;
    if (!workspace) return {};
    const kit = workspace.brandKits[0];
    const config = (kit?.watermark && typeof kit.watermark === 'object' && !Array.isArray(kit.watermark)
      ? kit.watermark
      : {}) as Record<string, unknown>;
    const position = typeof config.position === 'string' ? config.position : 'W-w-32:H-h-32';
    const opacity = typeof config.opacity === 'number' ? Math.max(0.1, Math.min(1, config.opacity)) : 0.75;
    const logoWidth = typeof config.size === 'number' ? Math.max(48, Math.min(420, config.size)) : 180;
    const text = typeof config.text === 'string' ? config.text.trim() : '';
    if (kit?.logoKey) {
      try {
        if (remote) {
          return {
            watermarkUrl: await this.storage.downloadUrl(kit.logoKey, 3600),
            watermarkPosition: position,
            watermarkOpacity: opacity,
            watermarkLogoWidth: logoWidth,
          };
        }
        const watermarkPath = await this.materializeBrandLogo(pipelineRunId, kit.logoKey);
        return {
          watermarkPath,
          watermarkPosition: position,
          watermarkOpacity: opacity,
          watermarkLogoWidth: logoWidth,
        };
      } catch {
        // An explicitly configured text may still be used when the custom logo is unavailable.
      }
    }
    if (!text) return {};
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

const UNRECOVERABLE_MEDIA_CODES = new Set([
  'URL_IMPORT_AUTH_REQUIRED',
  'SOURCE_SCHEME_UNSUPPORTED',
  'SOURCE_TOO_LARGE',
  'SOURCE_NOT_FOUND',
]);

function asUnrecoverableMediaError(error: unknown): UnrecoverableError | undefined {
  const code = mediaErrorCode(error);
  if (!code || !UNRECOVERABLE_MEDIA_CODES.has(code)) return undefined;
  const message = error instanceof Error ? error.message : 'Media worker stage failed';
  return Object.assign(new UnrecoverableError(message), { code });
}

function mediaErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
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

function automaticRenderFingerprint(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

function localArtifactPath(artifact: MediaStageResponse['artifacts'][number]): string {
  if (artifact.location?.type === 'local') return artifact.location.path;
  if (artifact.path) return artifact.path;
  throw Object.assign(new Error(`Media worker artifact ${artifact.kind} has no local path`), {
    code: 'ARTIFACT_PATH_MISSING',
  });
}

interface StoredMediaObject {
  key: string;
  bytes: number;
  mediaType: string;
  clipId?: string;
  exportId?: string;
  clipIndex?: number;
  sha256?: string;
}

function providerStorage(response: MediaStageResponse): StoredMediaObject[] {
  const value = response.metrics as { storage?: unknown };
  return Array.isArray(value.storage)
    ? value.storage.filter((item): item is StoredMediaObject => Boolean(item) && typeof item === 'object')
    : [];
}
