import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/env';
import { PIPELINE_STAGES, type PipelineStageName } from '../queues/pipeline.constants';
import { StageWorkerFactory } from '../queues/stage-worker.factory';
import { MediaStageProcessor } from './media-stage.processor';

export const DEFAULT_PIPELINE_STAGE_CONCURRENCY: Record<PipelineStageName, number> = {
  ingestion: 4,
  transcription: 2,
  segmentation: 3,
  scoring: 4,
  clips: 3,
  captions: 3,
  rendering: 2,
  exports: 3,
};

@Injectable()
export class MediaWorkersService implements OnApplicationBootstrap {
  private readonly concurrency: Record<PipelineStageName, number>;

  constructor(
    private readonly factory: StageWorkerFactory,
    private readonly processor: MediaStageProcessor,
    config: ConfigService<Environment, true>,
  ) {
    this.concurrency = parsePipelineStageConcurrency(config.get('PIPELINE_STAGE_CONCURRENCY_JSON', { infer: true }));
  }

  onApplicationBootstrap(): void {
    for (const [stage, workerConcurrency] of Object.entries(this.concurrency) as Array<[PipelineStageName, number]>) {
      this.factory.create(stage, (job) => this.processor.process(job), workerConcurrency);
    }
  }
}

export function parsePipelineStageConcurrency(raw: string): Record<PipelineStageName, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid PIPELINE_STAGE_CONCURRENCY_JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PIPELINE_STAGE_CONCURRENCY_JSON must be a JSON object');
  }
  const value = parsed as Record<string, unknown>;
  const result = { ...DEFAULT_PIPELINE_STAGE_CONCURRENCY };
  for (const stage of PIPELINE_STAGES) {
    if (value[stage] === undefined) continue;
    const concurrency = Number(value[stage]);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new Error(`PIPELINE_STAGE_CONCURRENCY_JSON.${stage} must be an integer between 1 and 32`);
    }
    result[stage] = concurrency;
  }
  return result;
}
