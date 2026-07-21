import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type PipelineStage } from '@prisma/client';
import type { Environment } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import {
  completedEventType,
  nextStage,
  pipelineJobSchema,
  prismaStage,
  type PipelineJob,
} from './pipeline.constants';

@Injectable()
export class PipelineOrchestratorService {
  private readonly autoRenderMode: 'off' | 'all';

  constructor(
    private readonly prisma: PrismaService,
    @Optional() config?: ConfigService<Environment, true>,
  ) {
    this.autoRenderMode = config?.get('AUTO_RENDER_MODE', { infer: true }) ?? 'off';
  }

  async begin(jobInput: PipelineJob): Promise<'started' | 'already-completed'> {
    const job = pipelineJobSchema.parse(jobInput);
    const stage = await this.prisma.stageExecution.findUnique({ where: { id: job.stageExecutionId } });
    if (!stage) throw new NotFoundException('Pipeline stage execution not found');
    if (stage.status === 'SUCCEEDED') return 'already-completed';
    const claimed = await this.prisma.stageExecution.updateMany({
      where: {
        id: stage.id,
        status: { in: ['PENDING', 'QUEUED', 'RETRYING'] },
      },
      data: { status: 'PROCESSING', attempts: { increment: 1 }, startedAt: stage.startedAt ?? new Date() },
    });
    if (claimed.count !== 1) throw new ConflictException('Pipeline stage is already being processed');
    await this.prisma.pipelineRun.update({
      where: { id: job.pipelineRunId },
      data: { status: 'RUNNING', currentStage: prismaStage(job.stage) as PipelineStage, startedAt: new Date() },
    });
    return 'started';
  }

  async complete(jobInput: PipelineJob): Promise<PipelineJob | null> {
    const job = pipelineJobSchema.parse(jobInput);
    const following = job.stage === 'composition' && this.autoRenderMode === 'off' ? null : nextStage(job.stage);
    return this.prisma.$transaction(async (tx) => {
      const completed = await tx.stageExecution.updateMany({
        where: { id: job.stageExecutionId, status: 'PROCESSING' },
        data: { status: 'SUCCEEDED', completedAt: new Date(), errorCode: null, errorMessage: null },
      });
      if (completed.count !== 1) {
        const current = await tx.stageExecution.findUnique({ where: { id: job.stageExecutionId } });
        if (current?.status === 'SUCCEEDED') return null;
        throw new ConflictException('Only a processing stage can be completed');
      }
      if (!following) {
        await tx.pipelineRun.update({
          where: { id: job.pipelineRunId },
          data: { status: 'SUCCEEDED', currentStage: null, completedAt: new Date() },
        });
        return null;
      }

      const eventId = randomUUID();
      const stageExecutionId = randomUUID();
      const occurredAt = new Date();
      const nextJob: PipelineJob = {
        schemaVersion: 1,
        eventId,
        pipelineRunId: job.pipelineRunId,
        stageExecutionId,
        videoId: job.videoId,
        ...(job.clipId ? { clipId: job.clipId } : {}),
        ...(job.exportId ? { exportId: job.exportId } : {}),
        ...(job.sourcePipelineRunId ? { sourcePipelineRunId: job.sourcePipelineRunId } : {}),
        ...(job.renderFingerprint ? { renderFingerprint: job.renderFingerprint } : {}),
        stage: following,
        correlationId: job.correlationId,
        causationId: job.eventId,
        occurredAt: occurredAt.toISOString(),
      };
      await tx.stageExecution.create({
        data: {
          id: stageExecutionId,
          pipelineRunId: job.pipelineRunId,
          stage: prismaStage(following) as PipelineStage,
          jobId: eventId,
        },
      });
      await tx.outboxEvent.create({
        data: {
          id: eventId,
          aggregateId: job.videoId,
          type: completedEventType(job.stage),
          payload: nextJob,
        },
      });
      await tx.pipelineRun.update({
        where: { id: job.pipelineRunId },
        data: { currentStage: prismaStage(following) as PipelineStage },
      });
      return nextJob;
    });
  }

  async retry(jobInput: PipelineJob, error: unknown): Promise<void> {
    const job = pipelineJobSchema.parse(jobInput);
    await this.prisma.stageExecution.update({
      where: { id: job.stageExecutionId },
      data: {
        status: 'RETRYING',
        errorCode: errorCode(error),
        errorMessage: safeErrorMessage(error),
      },
    });
  }

  async fail(jobInput: PipelineJob, error: unknown, options: { deadLettered?: boolean } = {}): Promise<void> {
    const job = pipelineJobSchema.parse(jobInput);
    const stageStatus = options.deadLettered === false ? 'FAILED' : 'DEAD_LETTERED';
    const operations: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.stageExecution.update({
        where: { id: job.stageExecutionId },
        data: {
          status: stageStatus,
          completedAt: new Date(),
          errorCode: errorCode(error),
          errorMessage: safeErrorMessage(error),
        },
      }),
      this.prisma.pipelineRun.update({
        where: { id: job.pipelineRunId },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          failureCode: errorCode(error),
          failureMessage: safeErrorMessage(error),
        },
      }),
    ];
    if (job.exportId) {
      operations.push(
        this.prisma.export.updateMany({
          where: { id: job.exportId, status: { in: ['QUEUED', 'PROCESSING'] } },
          data: {
            status: 'FAILED',
            errorCode: errorCode(error),
          },
        }),
      );
    } else if (job.stage === 'rendering' || job.stage === 'exports') {
      operations.push(
        this.prisma.export.updateMany({
          where: { sourcePipelineRunId: job.pipelineRunId, status: { in: ['QUEUED', 'PROCESSING'] } },
          data: { status: 'FAILED', errorCode: errorCode(error) },
        }),
        this.prisma.clip.updateMany({
          where: { videoId: job.videoId, status: 'RENDERING' },
          data: { status: 'FAILED' },
        }),
      );
    }
    await this.prisma.$transaction(operations);
  }
}

export function errorCode(error: unknown): string {
  if (typeof error === 'object' && error && 'code' in error && typeof error.code === 'string') {
    return error.code.replace(/[^A-Z0-9_]/gi, '_').slice(0, 80).toUpperCase();
  }
  return 'PIPELINE_STAGE_FAILED';
}

export function safeErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : 'Pipeline stage failed';
  return value.replace(/redis:\/\/[^\s]+/gi, '[redis-url]').replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

export function jsonPayload(payload: PipelineJob): Prisma.InputJsonObject {
  return payload as unknown as Prisma.InputJsonObject;
}
