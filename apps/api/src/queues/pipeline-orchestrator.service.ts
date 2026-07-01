import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PipelineStage } from '@prisma/client';
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
  constructor(private readonly prisma: PrismaService) {}

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
    const following = nextStage(job.stage);
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

  async fail(jobInput: PipelineJob, error: unknown): Promise<void> {
    const job = pipelineJobSchema.parse(jobInput);
    await this.prisma.$transaction([
      this.prisma.stageExecution.update({
        where: { id: job.stageExecutionId },
        data: {
          status: 'DEAD_LETTERED',
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
    ]);
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
