import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { PipelineStageName } from '../queues/pipeline.constants';
import { StageWorkerFactory } from '../queues/stage-worker.factory';
import { MediaStageProcessor } from './media-stage.processor';

const concurrency: Record<PipelineStageName, number> = {
  ingestion: 4,
  transcription: 1,
  segmentation: 2,
  scoring: 4,
  clips: 2,
  captions: 2,
  rendering: 1,
  exports: 2,
};

@Injectable()
export class MediaWorkersService implements OnApplicationBootstrap {
  constructor(
    private readonly factory: StageWorkerFactory,
    private readonly processor: MediaStageProcessor,
  ) {}

  onApplicationBootstrap(): void {
    for (const [stage, workerConcurrency] of Object.entries(concurrency) as Array<[PipelineStageName, number]>) {
      this.factory.create(stage, (job) => this.processor.process(job), workerConcurrency);
    }
  }
}
