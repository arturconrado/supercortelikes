import { Module } from '@nestjs/common';
import { OBJECT_STORAGE } from './storage.port';
import { R2StorageService } from './r2-storage.service';

@Module({
  providers: [R2StorageService, { provide: OBJECT_STORAGE, useExisting: R2StorageService }],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}
