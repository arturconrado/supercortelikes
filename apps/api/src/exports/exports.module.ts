import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ExportsController } from './exports.controller';

@Module({ imports: [StorageModule], controllers: [ExportsController] })
export class ExportsModule {}
