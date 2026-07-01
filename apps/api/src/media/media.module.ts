import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { UsageModule } from '../usage/usage.module';
import { MediaStageProcessor } from './media-stage.processor';
import { MediaWorkerClient } from './media-worker.client';
import { MediaWorkersService } from './media-workers.service';

@Module({
  imports: [StorageModule, UsageModule],
  providers: [MediaWorkerClient, MediaStageProcessor, MediaWorkersService],
  exports: [MediaWorkerClient, MediaStageProcessor],
})
export class MediaModule {}
