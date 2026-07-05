import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ClipRenderRequestService } from './clip-render-request.service';
import { ExportsController } from './exports.controller';

@Module({ imports: [StorageModule], controllers: [ExportsController], providers: [ClipRenderRequestService] })
export class ExportsModule {}
