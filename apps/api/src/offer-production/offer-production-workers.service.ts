import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import type { Environment } from '../config/env';
import { OFFER_PRODUCTION_QUEUE, offerProductionJobSchema, type OfferProductionJob } from './offer-production.constants';
import { OfferProductionProcessorService } from './offer-production-processor.service';

@Injectable()
export class OfferProductionWorkersService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly redisUrl: string;
  private readonly prefix: string;
  private worker?: Worker<OfferProductionJob>;

  constructor(
    private readonly processor: OfferProductionProcessorService,
    config: ConfigService<Environment, true>,
  ) {
    this.redisUrl = config.get('REDIS_URL', { infer: true });
    this.prefix = `${config.get('QUEUE_PREFIX', { infer: true })}-${config.get('NODE_ENV', { infer: true })}`;
  }

  onApplicationBootstrap(): void {
    const connection = new IORedis(this.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker<OfferProductionJob>(
      OFFER_PRODUCTION_QUEUE,
      async (bullJob: Job<OfferProductionJob>) => {
        const job = offerProductionJobSchema.parse(bullJob.data);
        if (job.eventId !== bullJob.id) throw new UnrecoverableError('Offer production job id mismatch');
        await this.processor.process(job);
      },
      { connection, prefix: this.prefix, concurrency: 2, maxStalledCount: 2 },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
