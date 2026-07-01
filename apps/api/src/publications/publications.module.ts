import { Module } from '@nestjs/common';
import { PublicationsController } from './publications.controller';

@Module({ controllers: [PublicationsController] })
export class PublicationsModule {}
