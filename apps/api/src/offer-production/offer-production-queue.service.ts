import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { Environment } from '../config/env';
import { OFFER_PRODUCTION_QUEUE, offerProductionJobOptions, type OfferProductionJob } from './offer-production.constants';

@Injectable()
export class OfferProductionQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly redis: IORedis;
  private readonly prefix: string;
  private readonly queue: Queue<OfferProductionJob>;

  constructor(config: ConfigService<Environment, true>) {
    this.prefix = `${config.get('QUEUE_PREFIX', { infer: true })}-${config.get('NODE_ENV', { infer: true })}`;
    this.redis = new IORedis(config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    this.queue = new Queue<OfferProductionJob>(OFFER_PRODUCTION_QUEUE, { connection: this.redis, prefix: this.prefix });
  }

  async onModuleInit(): Promise<void> {
    await this.redis.connect();
    await this.queue.waitUntilReady();
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    if (this.redis.status !== 'end') await this.redis.quit();
  }

  async add(eventType: string, job: OfferProductionJob): Promise<void> {
    await this.queue.add(eventType, job, offerProductionJobOptions(job.eventId));
  }
}
