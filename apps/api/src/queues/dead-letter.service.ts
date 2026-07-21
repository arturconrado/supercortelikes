import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { errorCode, safeErrorMessage } from './pipeline-orchestrator.service';
import { PIPELINE_STAGES, pipelineJobSchema, type PipelineJob } from './pipeline.constants';
import { QueueRegistryService } from './queue-registry.service';

@Injectable()
export class DeadLetterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistryService,
  ) {}

  async capture(queue: string, jobId: string, payload: unknown, error: unknown, attempts: number): Promise<void> {
    const parsed = pipelineJobSchema.safeParse(payload);
    const job: PipelineJob | null = parsed.success ? parsed.data : null;
    const safePayload = (job ?? { rejectedPayload: true }) as unknown as Prisma.InputJsonObject;
    const [pipelineRun, stageExecution] = job ? await Promise.all([
      this.prisma.pipelineRun.findUnique({ where: { id: job.pipelineRunId }, select: { id: true } }),
      this.prisma.stageExecution.findUnique({ where: { id: job.stageExecutionId }, select: { id: true } }),
    ]) : [null, null];
    const deadLetter = await this.prisma.deadLetterJob.upsert({
      where: { originalQueue_originalJobId: { originalQueue: queue, originalJobId: jobId } },
      create: {
        pipelineRunId: pipelineRun ? job?.pipelineRunId : null,
        stageExecutionId: stageExecution ? job?.stageExecutionId : null,
        originalQueue: queue,
        originalJobId: jobId,
        safePayload,
        errorCode: errorCode(error),
        errorMessage: safeErrorMessage(error),
        attempts,
      },
      update: {
        errorCode: errorCode(error),
        errorMessage: safeErrorMessage(error),
        attempts,
      },
    });
    await this.queues.addDeadLetter(deadLetter.id, {
      deadLetterId: deadLetter.id,
      originalQueue: queue,
      originalJobId: jobId,
      errorCode: deadLetter.errorCode,
      attempts,
    });
  }

  async redrive(id: string): Promise<string> {
    const deadLetter = await this.prisma.deadLetterJob.findUnique({ where: { id } });
    if (!deadLetter) throw new NotFoundException('Dead letter not found');
    if (deadLetter.status !== 'OPEN') throw new ConflictException('Only an open dead letter can be redriven');
    const parsed = pipelineJobSchema.safeParse(deadLetter.safePayload);
    if (!parsed.success || !deadLetter.stageExecutionId || !deadLetter.pipelineRunId) {
      throw new ConflictException('Dead letter does not contain a redrivable pipeline job');
    }
    const eventId = randomUUID();
    const job: PipelineJob = {
      ...parsed.data,
      eventId,
      causationId: parsed.data.eventId,
      occurredAt: new Date().toISOString(),
    };
    const stageIndex = PIPELINE_STAGES.indexOf(job.stage);
    const previousStage = stageIndex > 0 ? PIPELINE_STAGES[stageIndex - 1] : null;
    const eventType =
      job.stage === 'rendering'
        ? 'clip.render.requested.v1'
        : previousStage
          ? `pipeline.${previousStage}.completed.v1`
          : 'video.uploaded.v1';
    await this.prisma.$transaction([
      this.prisma.deadLetterJob.update({
        where: { id },
        data: { status: 'REDRIVEN', redriveCount: { increment: 1 }, resolvedAt: new Date() },
      }),
      this.prisma.stageExecution.update({
        where: { id: deadLetter.stageExecutionId },
        data: { status: 'PENDING', jobId: eventId, errorCode: null, errorMessage: null, completedAt: null },
      }),
      this.prisma.pipelineRun.update({
        where: { id: deadLetter.pipelineRunId },
        data: { status: 'RUNNING', completedAt: null, failureCode: null, failureMessage: null },
      }),
      this.prisma.outboxEvent.create({
        data: { id: eventId, aggregateId: job.videoId, type: eventType, payload: job as unknown as Prisma.InputJsonObject },
      }),
    ]);
    return eventId;
  }
}
