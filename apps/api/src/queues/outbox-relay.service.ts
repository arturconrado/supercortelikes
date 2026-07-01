import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type OutboxEvent, type PipelineStage } from '@prisma/client';
import type { Environment } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { DeadLetterService } from './dead-letter.service';
import { eventQueue, pipelineJobSchema, prismaStage, type PipelineJob } from './pipeline.constants';
import { safeErrorMessage } from './pipeline-orchestrator.service';
import { QueueRegistryService } from './queue-registry.service';
import { UsageService } from '../usage/usage.service';

type ClaimedEvent = Pick<OutboxEvent, 'id' | 'aggregateId' | 'type' | 'payload' | 'createdAt' | 'attempts'>;

class StaleOutboxEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleOutboxEventError';
  }
}

@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly relayId = randomUUID();
  private readonly pollInterval: number;
  private readonly batchSize: number;
  private timer?: NodeJS.Timeout;
  private dispatching = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistryService,
    private readonly deadLetters: DeadLetterService,
    config: ConfigService<Environment, true>,
    private readonly usage: UsageService,
  ) {
    this.pollInterval = config.get('OUTBOX_POLL_INTERVAL_MS', { infer: true });
    this.batchSize = config.get('OUTBOX_BATCH_SIZE', { infer: true });
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.dispatchBatch(), this.pollInterval);
    this.timer.unref();
    void this.dispatchBatch();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async dispatchBatch(): Promise<number> {
    if (this.dispatching) return 0;
    this.dispatching = true;
    try {
      const events = await this.claimBatch();
      for (const event of events) await this.dispatchOne(event);
      await this.queues.heartbeat('outbox-relay', 30);
      return events.length;
    } finally {
      this.dispatching = false;
    }
  }

  private async claimBatch(): Promise<ClaimedEvent[]> {
    return this.prisma.$queryRaw<ClaimedEvent[]>(Prisma.sql`
      WITH candidates AS (
        SELECT id
        FROM "outbox_events"
        WHERE "publishedAt" IS NULL
          AND "availableAt" <= NOW()
          AND ("lockedAt" IS NULL OR "lockedAt" < NOW() - INTERVAL '1 minute')
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${this.batchSize}
      )
      UPDATE "outbox_events" event
      SET "lockedAt" = NOW(), "lockedBy" = ${this.relayId}
      FROM candidates
      WHERE event.id = candidates.id
      RETURNING event.id, event."aggregateId", event.type, event.payload, event."createdAt", event.attempts
    `);
  }

  private async dispatchOne(event: ClaimedEvent): Promise<void> {
    try {
      const queueName = eventQueue(event.type);
      const job = await this.resolveJob(event);
      if (job.stage !== queueName) throw new Error(`Event route does not match payload stage ${job.stage}`);
      await this.assertPipelineReferences(event, job);
      const priority = await this.usage.queuePriorityForVideo(job.videoId);
      await this.queues.add(queueName, event.type, job, priority);
      await this.prisma.$transaction([
        this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: { publishedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null },
        }),
        this.prisma.stageExecution.updateMany({
          where: { id: job.stageExecutionId, status: 'PENDING' },
          data: { status: 'QUEUED' },
        }),
        this.prisma.pipelineRun.update({
          where: { id: job.pipelineRunId },
          data: { status: 'RUNNING', currentStage: prismaStage(job.stage) as PipelineStage, startedAt: new Date() },
        }),
      ]);
    } catch (error) {
      if (error instanceof StaleOutboxEventError) {
        await this.discardStaleEvent(event, error.message);
        return;
      }
      const attempts = event.attempts + 1;
      if (attempts >= 5) {
        await this.deadLetters.capture('outbox', event.id, event.payload, error, attempts);
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            attempts,
            publishedAt: new Date(),
            lockedAt: null,
            lockedBy: null,
            lastError: safeErrorMessage(error),
          },
        });
      } else {
        const delaySeconds = Math.min(60, 2 ** attempts);
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            attempts,
            availableAt: new Date(Date.now() + delaySeconds * 1000),
            lockedAt: null,
            lockedBy: null,
            lastError: safeErrorMessage(error),
          },
        });
      }
      this.logger.warn(`Outbox event ${event.id} dispatch failed (attempt ${attempts})`);
    }
  }

  private async assertPipelineReferences(event: ClaimedEvent, job: PipelineJob): Promise<void> {
    const [pipelineRun, stageExecution] = await Promise.all([
      this.prisma.pipelineRun.findUnique({ where: { id: job.pipelineRunId }, select: { id: true } }),
      this.prisma.stageExecution.findUnique({ where: { id: job.stageExecutionId }, select: { id: true } }),
    ]);
    if (!pipelineRun || !stageExecution) {
      throw new StaleOutboxEventError(
        `pipeline references for ${event.type} are no longer available; discarding stale outbox event`,
      );
    }
  }

  private async discardStaleEvent(event: ClaimedEvent, message: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id: event.id },
      data: { publishedAt: new Date(), lockedAt: null, lockedBy: null, lastError: message },
    });
    this.logger.warn(`Outbox event ${event.id} discarded: ${message}`);
  }

  private async resolveJob(event: ClaimedEvent): Promise<PipelineJob> {
    const parsed = pipelineJobSchema.safeParse(event.payload);
    if (parsed.success) return parsed.data;
    if (event.type !== 'video.uploaded' && event.type !== 'video.uploaded.v1') {
      throw new Error('Outbox payload does not match PipelineJob v1');
    }
    const raw = event.payload as Record<string, unknown>;
    const videoId = typeof raw.videoId === 'string' ? raw.videoId : event.aggregateId;
    let run = await this.prisma.pipelineRun.findUnique({
      where: { sourceEventId: event.id },
      include: { stages: { where: { stage: 'INGESTION' }, take: 1 } },
    });
    if (!run) {
      const video = await this.prisma.video.findUnique({ where: { id: videoId }, select: { id: true } });
      if (!video) {
        throw new StaleOutboxEventError(
          `video ${videoId} is no longer available; discarding stale outbox event`,
        );
      }
      const pipelineRunId = randomUUID();
      const stageExecutionId = randomUUID();
      run = await this.prisma.pipelineRun.create({
        data: {
          id: pipelineRunId,
          videoId,
          sourceEventId: event.id,
          currentStage: 'INGESTION',
          stages: {
            create: { id: stageExecutionId, stage: 'INGESTION', jobId: event.id },
          },
        },
        include: { stages: { where: { stage: 'INGESTION' }, take: 1 } },
      });
    }
    return {
      schemaVersion: 1,
      eventId: event.id,
      pipelineRunId: run.id,
      stageExecutionId: run.stages[0]!.id,
      videoId,
      stage: 'ingestion',
      correlationId: run.id,
      causationId: event.id,
      occurredAt: event.createdAt.toISOString(),
    };
  }
}
