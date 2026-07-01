import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import type { Environment } from '../config/env';
import { DeadLetterService } from './dead-letter.service';
import { pipelineJobSchema, type PipelineJob, type PipelineStageName } from './pipeline.constants';
import { PipelineOrchestratorService } from './pipeline-orchestrator.service';

export type StageProcessor = (job: PipelineJob) => Promise<void>;

@Injectable()
export class StageWorkerFactory implements OnModuleDestroy {
  private readonly redisUrl: string;
  private readonly prefix: string;
  private readonly workers: Worker<PipelineJob>[] = [];

  constructor(
    private readonly orchestrator: PipelineOrchestratorService,
    private readonly deadLetters: DeadLetterService,
    config: ConfigService<Environment, true>,
  ) {
    this.redisUrl = config.get('REDIS_URL', { infer: true });
    this.prefix = `${config.get('QUEUE_PREFIX', { infer: true })}-${config.get('NODE_ENV', { infer: true })}`;
  }

  create(stage: PipelineStageName, processor: StageProcessor, concurrency: number): Worker<PipelineJob> {
    const connection = new IORedis(this.redisUrl, { maxRetriesPerRequest: null });
    const worker = new Worker<PipelineJob>(
      stage,
      async (bullJob: Job<PipelineJob>) => {
        const job = pipelineJobSchema.parse(bullJob.data);
        if (job.stage !== stage) throw new UnrecoverableError(`Job stage ${job.stage} was sent to queue ${stage}`);
        const claimed = await this.orchestrator.begin(job);
        if (claimed === 'already-completed') return;
        try {
          await processor(job);
          await this.orchestrator.complete(job);
        } catch (error) {
          const maxAttempts = typeof bullJob.opts.attempts === 'number' ? bullJob.opts.attempts : 1;
          const terminal = error instanceof UnrecoverableError || bullJob.attemptsMade + 1 >= maxAttempts;
          if (terminal) {
            await this.orchestrator.fail(job, error);
            await this.deadLetters.capture(stage, bullJob.id ?? job.eventId, job, error, bullJob.attemptsMade + 1);
          } else {
            await this.orchestrator.retry(job, error);
          }
          throw error;
        }
      },
      {
        connection,
        prefix: this.prefix,
        concurrency,
        maxStalledCount: 2,
      },
    );
    this.workers.push(worker);
    return worker;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
}
