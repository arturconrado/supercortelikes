import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ContentController } from './content.controller';

@Module({ imports: [StorageModule], controllers: [ContentController] })
export class ContentModule {}
