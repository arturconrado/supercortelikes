import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { UsageModule } from '../usage/usage.module';
import { MediaStageProcessor } from './media-stage.processor';
import { MediaClientModule } from './media-client.module';
import { MediaWorkersService } from './media-workers.service';

@Module({
  imports: [StorageModule, UsageModule, MediaClientModule],
  providers: [MediaStageProcessor, MediaWorkersService],
  exports: [MediaClientModule, MediaStageProcessor],
})
export class MediaModule {}
