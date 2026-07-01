import { Module } from '@nestjs/common';
import { UsageModule } from '../usage/usage.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

@Module({ imports: [UsageModule], controllers: [BillingController], providers: [BillingService] })
export class BillingModule {}
