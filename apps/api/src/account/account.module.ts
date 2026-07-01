import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

@Module({ imports: [StorageModule], controllers: [AccountController], providers: [AccountService] })
export class AccountModule {}
