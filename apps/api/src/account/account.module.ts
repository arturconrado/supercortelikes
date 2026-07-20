import { Module } from '@nestjs/common';
import { VideosModule } from '../videos/videos.module';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

@Module({ imports: [VideosModule], controllers: [AccountController], providers: [AccountService] })
export class AccountModule {}
