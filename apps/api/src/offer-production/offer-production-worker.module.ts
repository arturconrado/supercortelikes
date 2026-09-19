import { Module } from '@nestjs/common';
import { OfferProductionModule } from './offer-production.module';
import { OfferProductionWorkersService } from './offer-production-workers.service';

@Module({
  imports: [OfferProductionModule],
  providers: [OfferProductionWorkersService],
})
export class OfferProductionWorkerModule {}
