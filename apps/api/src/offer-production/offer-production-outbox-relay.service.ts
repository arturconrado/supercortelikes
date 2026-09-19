import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type OfferProductionOutboxEvent } from '@prisma/client';
import type { Environment } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { safeErrorMessage } from '../queues/pipeline-orchestrator.service';
import { offerProductionJobSchema, type OfferProductionJob } from './offer-production.constants';
import { OfferProductionQueueService } from './offer-production-queue.service';

type ClaimedOfferEvent = Pick<OfferProductionOutboxEvent, 'id' | 'launchRunId' | 'type' | 'payload' | 'attempts'>;

@Injectable()
export class OfferProductionOutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OfferProductionOutboxRelayService.name);
  private readonly relayId = randomUUID();
  private readonly pollInterval: number;
  private readonly batchSize: number;
  private timer?: NodeJS.Timeout;
  private dispatching = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: OfferProductionQueueService,
    config: ConfigService<Environment, true>,
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
      return events.length;
    } finally {
      this.dispatching = false;
    }
  }

  private async claimBatch(): Promise<ClaimedOfferEvent[]> {
    return this.prisma.$queryRaw<ClaimedOfferEvent[]>(Prisma.sql`
      WITH candidates AS (
        SELECT id
        FROM "offer_production_outbox_events"
        WHERE "publishedAt" IS NULL
          AND "availableAt" <= NOW()
          AND ("lockedAt" IS NULL OR "lockedAt" < NOW() - INTERVAL '1 minute')
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${this.batchSize}
      )
      UPDATE "offer_production_outbox_events" event
      SET "lockedAt" = NOW(), "lockedBy" = ${this.relayId}
      FROM candidates
      WHERE event.id = candidates.id
      RETURNING event.id, event."launchRunId", event.type, event.payload, event.attempts
    `);
  }

  private async dispatchOne(event: ClaimedOfferEvent): Promise<void> {
    try {
      const job = this.resolveJob(event);
      await this.assertReferences(job);
      await this.queue.add(event.type, job);
      await this.prisma.$transaction([
        this.prisma.offerProductionOutboxEvent.update({
          where: { id: event.id },
          data: { publishedAt: new Date(), lockedAt: null, lockedBy: null, lastError: null },
        }),
        this.prisma.offerProductionStageExecution.updateMany({
          where: { id: job.stageExecutionId, status: 'PENDING' },
          data: { status: 'QUEUED' },
        }),
        this.prisma.offerLaunchRun.update({
          where: { id: job.launchRunId },
          data: { status: 'RUNNING' },
        }),
      ]);
    } catch (error) {
      const attempts = event.attempts + 1;
      const terminal = attempts >= 5;
      await this.prisma.offerProductionOutboxEvent.update({
        where: { id: event.id },
        data: {
          attempts,
          availableAt: terminal ? new Date() : new Date(Date.now() + Math.min(60, 2 ** attempts) * 1000),
          publishedAt: terminal ? new Date() : null,
          lockedAt: null,
          lockedBy: null,
          lastError: safeErrorMessage(error),
        },
      });
      this.logger.warn(`Offer production outbox event ${event.id} dispatch failed (attempt ${attempts})`);
    }
  }

  private resolveJob(event: ClaimedOfferEvent): OfferProductionJob {
    const parsed = offerProductionJobSchema.safeParse(event.payload);
    if (!parsed.success) throw new Error('Offer production payload does not match job schema v1');
    if (parsed.data.launchRunId !== event.launchRunId) throw new Error('Offer production event launch run mismatch');
    return parsed.data;
  }

  private async assertReferences(job: OfferProductionJob): Promise<void> {
    const [launchRun, stageExecution, product] = await Promise.all([
      this.prisma.offerLaunchRun.findUnique({ where: { id: job.launchRunId }, select: { id: true } }),
      this.prisma.offerProductionStageExecution.findUnique({ where: { id: job.stageExecutionId }, select: { id: true } }),
      this.prisma.digitalProduct.findUnique({ where: { id: job.productId }, select: { id: true } }),
    ]);
    if (!launchRun || !stageExecution || !product) throw new Error('Offer production references are no longer available');
  }
}
