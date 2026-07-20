import { Module } from '@nestjs/common';
import { MediaWorkerClient } from './media-worker.client';

@Module({
  providers: [MediaWorkerClient],
  exports: [MediaWorkerClient],
})
export class MediaClientModule {}
