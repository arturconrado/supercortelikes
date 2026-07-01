import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { UsageModule } from '../usage/usage.module';
import { PrismaVideoRepository } from './prisma-video.repository';
import { VIDEO_REPOSITORY } from './video.repository';
import { VideoUploadService } from './video-upload.service';
import { VideosController } from './videos.controller';
import { VideoImportService } from './video-import.service';
import { DirectUploadService } from './direct-upload.service';

@Module({
  imports: [StorageModule, UsageModule],
  controllers: [VideosController],
  providers: [
    PrismaVideoRepository,
    { provide: VIDEO_REPOSITORY, useExisting: PrismaVideoRepository },
    VideoUploadService,
    VideoImportService,
    DirectUploadService,
  ],
})
export class VideosModule {}
