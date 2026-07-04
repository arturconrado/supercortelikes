import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';
import { DeadLetterService } from '../queues/dead-letter.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/storage.port';
import { ClipExportDto, RenderClipDto, UpdateClipCaptionsDto, UpdateClipDto, UpdateClipTimingDto } from './content.dto';

const PIPELINE_STAGE_COUNT = 8;

@Controller()
export class ContentController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deadLetters: DeadLetterService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Get('videos')
  async videos(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page') pageValue?: string,
    @Query('projectId') projectId?: string,
  ): Promise<unknown> {
    const page = Math.max(1, Number.parseInt(pageValue ?? '1', 10) || 1);
    const pageSize = 24;
    const where = { workspaceId: user.workspaceId, ...(projectId ? { projectId } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.video.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          _count: { select: { clips: true } },
          pipelineRuns: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, currentStage: true } },
        },
      }),
      this.prisma.video.count({ where }),
    ]);
    return serialize({
      items: await Promise.all(items.map((item) => this.videoListView(item))),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    });
  }

  private async videoListView(item: Record<string, any>): Promise<Record<string, unknown>> {
    return {
      ...item,
      durationSeconds: item.durationMs ? Number(item.durationMs) / 1000 : undefined,
      clipsCount: item._count.clips,
      thumbnailUrl: item.thumbnailKey ? await this.storage.downloadUrl(item.thumbnailKey, 900) : undefined,
    };
  }

  @Get('videos/:id/clips')
  async videoClips(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<unknown> {
    const video = await this.prisma.video.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { id: true } });
    if (!video) throw new NotFoundException('Video not found');
    const clips = await this.prisma.clip.findMany({
      where: { videoId: id },
      orderBy: { score: 'desc' },
      include: { captions: true, exports: true, seo: true, video: true },
    });
    return serialize(await Promise.all(clips.map((clip) => this.clipView(clip))));
  }

  @Get('videos/:id/pipeline')
  async videoPipeline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<unknown> {
    const video = await this.prisma.video.findFirst({
      where: { id, workspaceId: user.workspaceId },
      select: {
        id: true,
        status: true,
        failureCode: true,
        failureMessage: true,
        pipelineRuns: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: {
            stages: { orderBy: { createdAt: 'asc' } },
            deadLetters: { where: { status: 'OPEN' }, orderBy: { createdAt: 'desc' }, take: 5 },
          },
        },
      },
    });
    if (!video) throw new NotFoundException('Video not found');
    const run = video.pipelineRuns[0];
    const succeeded = run?.stages.filter((stage) => stage.status === 'SUCCEEDED').length ?? 0;
    return serialize({
      videoId: video.id,
      status: video.status,
      failureCode: video.failureCode,
      failureMessage: video.failureMessage,
      progress: run?.status === 'SUCCEEDED' ? 100 : Math.round((succeeded / PIPELINE_STAGE_COUNT) * 100),
      run: run
        ? {
            id: run.id,
            status: run.status,
            currentStage: run.currentStage,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            failureCode: run.failureCode,
            failureMessage: run.failureMessage,
            stages: run.stages.map((stage) => ({
              id: stage.id,
              stage: stage.stage,
              status: stage.status,
              attempts: stage.attempts,
              startedAt: stage.startedAt,
              completedAt: stage.completedAt,
              errorCode: stage.errorCode,
              errorMessage: stage.errorMessage,
            })),
            openDeadLetters: run.deadLetters.map((item) => ({
              id: item.id,
              queue: item.originalQueue,
              errorCode: item.errorCode,
              errorMessage: item.errorMessage,
              attempts: item.attempts,
              createdAt: item.createdAt,
            })),
          }
        : null,
    });
  }

  @Get('videos/:id/transcript')
  async videoTranscript(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<unknown> {
    const transcript = await this.prisma.transcript.findFirst({
      where: { videoId: id, video: { workspaceId: user.workspaceId } },
    });
    if (!transcript) throw new NotFoundException('Transcript not found');
    return serialize({
      id: transcript.id,
      videoId: transcript.videoId,
      language: transcript.language,
      detectedLanguage: transcript.language,
      confidence: transcript.confidence,
      fullText: transcript.fullText,
      words: transcript.words,
      speakers: transcript.speakers,
      durationSeconds: Number(transcript.durationMs) / 1000,
      createdAt: transcript.createdAt,
      updatedAt: transcript.updatedAt,
    });
  }

  @Post('videos/:id/retry')
  async retryVideo(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ eventId: string }> {
    const video = await this.prisma.video.findFirst({ where: { id, workspaceId: user.workspaceId }, select: { id: true } });
    if (!video) throw new NotFoundException('Video not found');
    const deadLetter = await this.prisma.deadLetterJob.findFirst({
      where: { status: 'OPEN', pipelineRun: { videoId: id } },
      orderBy: { createdAt: 'desc' },
    });
    if (!deadLetter) throw new BadRequestException('No failed pipeline job is available to retry');
    return { eventId: await this.deadLetters.redrive(deadLetter.id) };
  }

  @Get('clips/:id')
  async clip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<unknown> {
    return serialize(await this.fullClip(id, user.workspaceId));
  }

  @Patch('clips/:id')
  async updateClip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateClipDto,
  ): Promise<unknown> {
    const clip = await this.prisma.clip.findFirst({
      where: { id, video: { workspaceId: user.workspaceId } },
      include: { seo: true },
    });
    if (!clip) throw new NotFoundException('Clip not found');
    await this.prisma.$transaction(async (tx) => {
      await tx.clip.update({
        where: { id },
        data: {
          ...(input.title ? { title: input.title.trim() } : {}),
          ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
          ...(input.status ? { status: input.status } : {}),
        },
      });
      if (input.description !== undefined || input.hashtags !== undefined) {
        const hashtags = input.hashtags?.map((tag) => tag.trim()).filter(Boolean) ?? (clip.seo?.hashtags as string[] | undefined) ?? [];
        await tx.seoMetadata.upsert({
          where: { clipId: id },
          create: {
            clipId: id,
            titles: clip.titleSuggestions as Prisma.InputJsonArray,
            ctrScores: [] as Prisma.InputJsonArray,
            description: input.description?.trim() ?? '',
            hashtags: hashtags as Prisma.InputJsonArray,
            keywords: [] as Prisma.InputJsonArray,
          },
          update: {
            ...(input.description !== undefined ? { description: input.description.trim() } : {}),
            ...(input.hashtags !== undefined ? { hashtags: hashtags as Prisma.InputJsonArray } : {}),
          },
        });
      }
    });
    return serialize(await this.fullClip(id, user.workspaceId));
  }

  @Patch('clips/:id/timing')
  async updateTiming(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateClipTimingDto,
  ): Promise<unknown> {
    if (input.endSeconds <= input.startSeconds) throw new BadRequestException('Clip end must be greater than start');
    await this.ensureClip(id, user.workspaceId);
    await this.prisma.clip.update({
      where: { id },
      data: {
        startMs: BigInt(Math.round(input.startSeconds * 1000)),
        endMs: BigInt(Math.round(input.endSeconds * 1000)),
        status: 'SUGGESTED',
      },
    });
    return serialize(await this.fullClip(id, user.workspaceId));
  }

  @Patch('clips/:id/captions')
  async updateCaptions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateClipCaptionsDto,
  ): Promise<unknown> {
    await this.ensureClip(id, user.workspaceId);
    const current = await this.prisma.captionTrack.findFirst({ where: { clipId: id }, orderBy: { createdAt: 'asc' } });
    if (current) {
      await this.prisma.captionTrack.update({
        where: { id: current.id },
        data: {
          editedCues: input.cues as Prisma.InputJsonArray,
          ...(input.language ? { language: input.language } : {}),
          ...(input.template ? { template: input.template } : {}),
          ...(input.style ? { style: input.style as Prisma.InputJsonObject } : {}),
        },
      });
    } else {
      await this.prisma.captionTrack.create({
        data: {
          clipId: id,
          template: input.template ?? 'podcast',
          language: input.language ?? 'pt',
          cues: input.cues as Prisma.InputJsonArray,
          editedCues: input.cues as Prisma.InputJsonArray,
          ...(input.style ? { style: input.style as Prisma.InputJsonObject } : {}),
        },
      });
    }
    await this.prisma.clip.update({ where: { id }, data: { status: 'SUGGESTED' } });
    return serialize(await this.fullClip(id, user.workspaceId));
  }

  @Post('clips/:id/render')
  async renderClip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: RenderClipDto,
  ): Promise<unknown> {
    const clip = await this.ensureClip(id, user.workspaceId);
    if (input.aspectRatio && input.aspectRatio !== clip.aspectRatio) {
      await this.prisma.clip.update({ where: { id }, data: { aspectRatio: input.aspectRatio, status: 'SUGGESTED' } });
    }
    const exportJob = await this.ensureExport(id, 'MP4', input.aspectRatio ?? clip.aspectRatio);
    if (exportJob.status !== 'READY') await this.queueRenderingRun(clip.videoId, input.force ?? false);
    return serialize({ ...exportJob, sizeBytes: exportJob.sizeBytes?.toString() ?? null });
  }

  @Post('clips/:id/export')
  async exportClip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: ClipExportDto,
  ): Promise<unknown> {
    const clip = await this.ensureClip(id, user.workspaceId);
    const exportJob = await this.ensureExport(id, input.format ?? 'MP4', input.aspectRatio ?? clip.aspectRatio);
    if (exportJob.status !== 'READY') await this.queueRenderingRun(clip.videoId, false);
    return serialize({ ...exportJob, sizeBytes: exportJob.sizeBytes?.toString() ?? null });
  }

  private async ensureClip(id: string, workspaceId: string) {
    const clip = await this.prisma.clip.findFirst({
      where: { id, video: { workspaceId } },
      include: { video: true, exports: true },
    });
    if (!clip) throw new NotFoundException('Clip not found');
    return clip;
  }

  private async fullClip(id: string, workspaceId: string): Promise<Record<string, unknown>> {
    const clip = await this.prisma.clip.findFirst({
      where: { id, video: { workspaceId } },
      include: { video: true, segment: { include: { viralScore: true } }, captions: true, exports: true, seo: true },
    });
    if (!clip) throw new NotFoundException('Clip not found');
    return this.clipView(clip);
  }

  private async clipView(clip: Record<string, any>): Promise<Record<string, unknown>> {
    const readyExport = clip.exports?.find((item: { status: string; storageKey?: string | null }) => item.status === 'READY' && item.storageKey);
    const caption = clip.captions?.[0];
    const captionStorageKey = isStorageKey(caption?.srtKey) ? caption.srtKey : undefined;
    const renderUrl = readyExport?.storageKey ? await this.storage.downloadUrl(readyExport.storageKey, 900) : undefined;
    const sourcePreviewUrl = renderUrl ? undefined : await this.sourcePreviewUrl(clip);
    const { video: _video, ...clipFields } = clip;
    return {
      ...clipFields,
      startSeconds: clip.startMs !== undefined ? Number(clip.startMs) / 1000 : undefined,
      endSeconds: clip.endMs !== undefined ? Number(clip.endMs) / 1000 : undefined,
      durationSeconds:
        clip.startMs !== undefined && clip.endMs !== undefined ? Number(clip.endMs - clip.startMs) / 1000 : undefined,
      description: clip.seo?.description,
      hashtags: clip.seo?.hashtags,
      titleSuggestions: clip.seo?.titles ?? clip.titleSuggestions,
      captionsEdited: Boolean(clip.captions?.some((item: { editedCues?: unknown }) => item.editedCues)),
      captions: clip.captions?.map((item: Record<string, unknown>) => ({
        id: item.id,
        template: item.template,
        language: item.language,
        cues: item.editedCues ?? item.cues,
        style: item.style,
      })),
      thumbnailUrl: clip.thumbnailKey ? await this.storage.downloadUrl(clip.thumbnailKey, 900) : undefined,
      renderUrl,
      playbackUrl: renderUrl ?? sourcePreviewUrl,
      downloadUrl: renderUrl,
      captionsUrl: captionStorageKey ? await this.storage.downloadUrl(captionStorageKey, 900) : undefined,
    };
  }

  private async sourcePreviewUrl(clip: Record<string, any>): Promise<string | undefined> {
    const key = clip.video?.storageKey;
    if (!isStorageKey(key)) return undefined;
    const sourceUrl = await this.storage.downloadUrl(key, 900);
    const startSeconds = clip.startMs !== undefined ? Number(clip.startMs) / 1000 : undefined;
    const endSeconds = clip.endMs !== undefined ? Number(clip.endMs) / 1000 : undefined;
    return appendMediaFragment(sourceUrl, startSeconds, endSeconds);
  }

  private async ensureExport(clipId: string, format: string, aspectRatio: string) {
    const existing = await this.prisma.export.findFirst({
      where: { clipId, format, aspectRatio, status: { in: ['READY', 'QUEUED', 'PROCESSING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return existing;
    await this.prisma.clip.update({ where: { id: clipId }, data: { status: 'RENDERING' } });
    return this.prisma.export.create({ data: { clipId, format, aspectRatio, status: 'QUEUED' } });
  }

  private async queueRenderingRun(videoId: string, force: boolean): Promise<void> {
    if (!force) {
      const active = await this.prisma.pipelineRun.findFirst({
        where: { videoId, status: { in: ['PENDING', 'RUNNING'] }, currentStage: { in: ['RENDERING', 'EXPORTS'] } },
      });
      if (active) return;
    }
    const eventId = randomUUID();
    const pipelineRunId = randomUUID();
    const stageExecutionId = randomUUID();
    const occurredAt = new Date();
    const job = {
      schemaVersion: 1,
      eventId,
      pipelineRunId,
      stageExecutionId,
      videoId,
      stage: 'rendering',
      correlationId: pipelineRunId,
      causationId: eventId,
      occurredAt: occurredAt.toISOString(),
    };
    await this.prisma.$transaction([
      this.prisma.pipelineRun.create({
        data: {
          id: pipelineRunId,
          videoId,
          sourceEventId: eventId,
          status: 'PENDING',
          currentStage: 'RENDERING',
        },
      }),
      this.prisma.stageExecution.create({
        data: {
          id: stageExecutionId,
          pipelineRunId,
          stage: 'RENDERING',
          jobId: eventId,
        },
      }),
      this.prisma.outboxEvent.create({
        data: {
          id: eventId,
          aggregateId: videoId,
          type: 'pipeline.captions.completed.v1',
          payload: job as unknown as Prisma.InputJsonObject,
        },
      }),
    ]);
  }
}

function serialize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item)));
}

function isStorageKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value);
}

function appendMediaFragment(url: string, startSeconds?: number, endSeconds?: number): string {
  if (startSeconds === undefined || endSeconds === undefined || endSeconds <= startSeconds) return url;
  return `${url}#t=${formatMediaTime(startSeconds)},${formatMediaTime(endSeconds)}`;
}

function formatMediaTime(value: number): string {
  return Math.max(0, value).toFixed(3).replace(/\.?0+$/, '');
}
