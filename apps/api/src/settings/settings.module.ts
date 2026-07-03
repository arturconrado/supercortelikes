import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({ imports: [StorageModule], controllers: [SettingsController], providers: [SettingsService] })
export class SettingsModule {}
