import { Module } from '@nestjs/common';
import { OfferProductionOutboxRelayService } from './offer-production-outbox-relay.service';
import { OfferProductionProcessorService } from './offer-production-processor.service';
import { OfferProductionQueueService } from './offer-production-queue.service';

@Module({
  providers: [OfferProductionQueueService, OfferProductionOutboxRelayService, OfferProductionProcessorService],
  exports: [OfferProductionProcessorService, OfferProductionQueueService],
})
export class OfferProductionModule {}
