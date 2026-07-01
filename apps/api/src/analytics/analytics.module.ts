import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { AnalyticsController } from './analytics.controller';

@Module({ imports: [StorageModule], controllers: [AnalyticsController] })
export class AnalyticsModule {}
