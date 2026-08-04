import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectProcessingService } from './project-processing.service';

@Module({ controllers: [ProjectsController], providers: [ProjectProcessingService] })
export class ProjectsModule {}
