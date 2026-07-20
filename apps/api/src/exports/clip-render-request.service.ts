import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { Environment } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { MetricsService } from '../observability/metrics.service';
import type { PipelineJob } from '../queues/pipeline.constants';
import { limitsFor } from '../usage/entitlements';

const RENDER_CACHE_VERSION = 'clip-render-720p-v3-square-pixels';
const REUSABLE_EXPORT_STATUSES = ['READY', 'QUEUED', 'PROCESSING'] as const;

type RenderRequestInput = {
  clipId: string;
  format?: string;
  aspectRatio?: string;
  force?: boolean;
};

@Injectable()
export class ClipRenderRequestService {
  private readonly ffmpegPreset: string;
  private readonly ffmpegCrf: number;
  private readonly renderMaxHeight: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Environment, true>,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.ffmpegPreset = config.get('FFMPEG_PRESET', { infer: true });
    this.ffmpegCrf = config.get('FFMPEG_CRF', { infer: true });
    this.renderMaxHeight = config.get('RENDER_MAX_HEIGHT', { infer: true });
  }

  async request(user: AuthenticatedUser, input: RenderRequestInput): Promise<Record<string, unknown>> {
    const startedAt = process.hrtime.bigint();
    let result = 'queued';
    try {
      const output = await this.requestInternal(user, input);
      result = output.result;
      return output.response;
    } catch (error) {
      result = 'failed';
      throw error;
    } finally {
      this.recordRenderRequest(result, startedAt);
    }
  }

  private async requestInternal(
    user: AuthenticatedUser,
    input: RenderRequestInput,
  ): Promise<{ response: Record<string, unknown>; result: 'cache' | 'queued' }> {
    const clip = await this.prisma.clip.findFirst({
      where: { id: input.clipId, video: { workspaceId: user.workspaceId } },
      include: {
        captions: { orderBy: { createdAt: 'asc' }, take: 1 },
        video: {
          include: {
            workspace: {
              select: {
                plan: true,
                brandKits: {
                  orderBy: { createdAt: 'asc' },
                  take: 1,
                  select: { id: true, logoKey: true, watermark: true, updatedAt: true },
                },
              },
            },
          },
        },
      },
    });
    if (!clip) throw new NotFoundException('Clip not found');
    const format = input.format ?? 'MP4';
    const aspectRatio = input.aspectRatio ?? clip.aspectRatio;
    if (format !== 'MP4') throw new ConflictException('Only MP4 exports are supported');
    const sourceRun = await this.findSourcePipelineRun(clip.videoId);
    if (aspectRatio !== clip.aspectRatio) {
      await this.prisma.clip.update({ where: { id: clip.id }, data: { aspectRatio, status: 'SUGGESTED' } });
    }
    const fingerprint = renderFingerprint({
      format,
      aspectRatio,
      clip: {
        id: clip.id,
        startMs: clip.startMs.toString(),
        endMs: clip.endMs.toString(),
      },
      caption: clip.captions[0]
        ? {
            template: clip.captions[0].template,
            language: clip.captions[0].language,
            cues: clip.captions[0].editedCues ?? clip.captions[0].cues,
            style: clip.captions[0].style,
          }
        : null,
      watermark: watermarkFingerprintPayload(clip.video.workspace),
      render: {
        version: RENDER_CACHE_VERSION,
        preset: this.ffmpegPreset,
        crf: this.ffmpegCrf,
        maxHeight: this.renderMaxHeight,
      },
    });
    if (!input.force) {
      const existing = await this.prisma.export.findFirst({
        where: {
          clipId: clip.id,
          renderFingerprint: fingerprint,
          status: { in: [...REUSABLE_EXPORT_STATUSES] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) return { response: exportResponse(existing), result: 'cache' };
    }

    const eventId = randomUUID();
    const exportId = randomUUID();
    const pipelineRunId = randomUUID();
    const stageExecutionId = randomUUID();
    const job: PipelineJob = {
      schemaVersion: 1,
      eventId,
      pipelineRunId,
      stageExecutionId,
      videoId: clip.videoId,
      clipId: clip.id,
      exportId,
      sourcePipelineRunId: sourceRun.id,
      renderFingerprint: fingerprint,
      stage: 'rendering',
      correlationId: pipelineRunId,
      causationId: eventId,
      occurredAt: new Date().toISOString(),
    };
    const [created] = await this.prisma.$transaction([
      this.prisma.export.create({
        data: {
          id: exportId,
          clipId: clip.id,
          format,
          aspectRatio,
          status: 'QUEUED',
          renderFingerprint: fingerprint,
          sourcePipelineRunId: sourceRun.id,
        },
      }),
      this.prisma.clip.update({ where: { id: clip.id }, data: { status: 'RENDERING' } }),
      this.prisma.pipelineRun.create({
        data: {
          id: pipelineRunId,
          videoId: clip.videoId,
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
          aggregateId: clip.videoId,
          type: 'clip.render.requested.v1',
          payload: job as unknown as Prisma.InputJsonObject,
        },
      }),
    ]);
    return { response: exportResponse(created), result: 'queued' };
  }

  private async findSourcePipelineRun(videoId: string): Promise<{ id: string }> {
    const run = await this.prisma.pipelineRun.findFirst({
      where: {
        videoId,
        stages: { some: { stage: 'CAPTIONS', status: 'SUCCEEDED' } },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!run) throw new ConflictException('O vídeo ainda não concluiu cortes e legendas para exportação.');
    return run;
  }

  private recordRenderRequest(result: string, startedAt: bigint): void {
    this.metrics?.renderRequests.inc({ result });
    this.metrics?.renderRequestDuration.observe({ result }, Number(process.hrtime.bigint() - startedAt) / 1_000_000_000);
  }
}

function exportResponse(item: { sizeBytes?: bigint | number | null } & Record<string, unknown>): Record<string, unknown> {
  return { ...item, sizeBytes: item.sizeBytes?.toString() ?? null };
}

function watermarkFingerprintPayload(
  workspace: {
    plan: Parameters<typeof limitsFor>[0];
    brandKits: Array<{ id: string; logoKey: string | null; watermark: Prisma.JsonValue | null; updatedAt: Date }>;
  } | null,
): unknown {
  if (!workspace || !limitsFor(workspace.plan).watermark) return false;
  const kit = workspace.brandKits[0];
  return kit
    ? { logoKey: kit.logoKey, watermark: kit.watermark, updatedAt: kit.updatedAt.toISOString() }
    : { text: 'PicaShorts' };
}

function renderFingerprint(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
