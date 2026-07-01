import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { Environment } from '../config/env';
import {
  ALL_QUEUE_NAMES,
  type PipelineJob,
  type PipelineStageName,
  type QueueName,
  queueJobOptions,
} from './pipeline.constants';

export interface QueueDiagnostics {
  workers: number;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  paused: boolean;
}

@Injectable()
export class QueueRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly redis: IORedis;
  private readonly prefix: string;
  private readonly queues = new Map<QueueName, Queue>();

  constructor(config: ConfigService<Environment, true>) {
    this.prefix = `${config.get('QUEUE_PREFIX', { infer: true })}-${config.get('NODE_ENV', { infer: true })}`;
    this.redis = new IORedis(config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.redis.connect();
    for (const name of ALL_QUEUE_NAMES) {
      this.queues.set(name, new Queue(name, { connection: this.redis, prefix: this.prefix }));
    }
    await Promise.all([...this.queues.values()].map((queue) => queue.waitUntilReady()));
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    if (this.redis.status !== 'end') await this.redis.quit();
  }

  async add(queueName: PipelineStageName, eventType: string, job: PipelineJob, priority?: number): Promise<void> {
    await this.queue(queueName).add(eventType, job, queueJobOptions(queueName, job.eventId, priority));
  }

  async addDeadLetter(jobId: string, payload: Record<string, unknown>): Promise<void> {
    await this.queue('dead-letter').add('pipeline.dead-letter.v1', payload, {
      jobId,
      attempts: 10,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 30 * 24 * 60 * 60, count: 100_000 },
      removeOnFail: false,
    });
  }

  async ping(): Promise<'PONG'> {
    return (await this.redis.ping()) as 'PONG';
  }

  essentialQueuesRegistered(): boolean {
    return ALL_QUEUE_NAMES.every((name) => this.queues.has(name));
  }

  async heartbeat(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(`${this.prefix}:heartbeat:${key}`, new Date().toISOString(), 'EX', ttlSeconds);
  }

  async heartbeatExists(key: string): Promise<boolean> {
    return (await this.redis.exists(`${this.prefix}:heartbeat:${key}`)) === 1;
  }

  async diagnostics(): Promise<Record<QueueName, QueueDiagnostics>> {
    const entries = await Promise.all(
      ALL_QUEUE_NAMES.map(async (name): Promise<[QueueName, QueueDiagnostics]> => {
        const queue = this.queue(name);
        const [counts, workers, paused] = await Promise.all([
          queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
          queue.getWorkersCount(),
          queue.isPaused(),
        ]);
        return [
          name,
          {
            workers,
            waiting: counts.waiting,
            active: counts.active,
            delayed: counts.delayed,
            failed: counts.failed,
            paused,
          },
        ];
      }),
    );
    return Object.fromEntries(entries) as Record<QueueName, QueueDiagnostics>;
  }

  queue(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Queue ${name} is not initialized`);
    return queue;
  }
}
