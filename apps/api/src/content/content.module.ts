import { Module } from '@nestjs/common';
import { ClipRenderRequestService } from '../exports/clip-render-request.service';
import { StorageModule } from '../storage/storage.module';
import { ContentController } from './content.controller';

@Module({ imports: [StorageModule], controllers: [ContentController], providers: [ClipRenderRequestService] })
export class ContentModule {}
