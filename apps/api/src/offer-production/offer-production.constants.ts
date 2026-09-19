import type { JobsOptions } from 'bullmq';
import { z } from 'zod';

export const OFFER_PRODUCTION_QUEUE = 'offer-production';

export const OFFER_PRODUCTION_STAGES = ['OFFER', 'MEDIA_ASSETS', 'PUBLICATION_DRAFTS', 'METRICS_SETUP'] as const;

export const offerProductionJobSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  launchRunId: z.string().uuid(),
  stageExecutionId: z.string().uuid(),
  opportunityId: z.string().uuid(),
  productId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  stage: z.enum(OFFER_PRODUCTION_STAGES),
  correlationId: z.string().uuid(),
  causationId: z.string().uuid(),
  occurredAt: z.string().datetime(),
});

export type OfferProductionJob = z.infer<typeof offerProductionJobSchema>;
export type OfferProductionStage = (typeof OFFER_PRODUCTION_STAGES)[number];

export function nextOfferProductionStage(stage: OfferProductionStage): OfferProductionStage | null {
  const index = OFFER_PRODUCTION_STAGES.indexOf(stage);
  return index === OFFER_PRODUCTION_STAGES.length - 1 ? null : OFFER_PRODUCTION_STAGES[index + 1]!;
}

export function completedOfferProductionEventType(stage: OfferProductionStage): string {
  return `offer.production.${stage.toLowerCase()}.completed.v1`;
}

export function offerProductionJobOptions(jobId: string): JobsOptions {
  return {
    jobId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10_000 },
    removeOnFail: { age: 30 * 24 * 60 * 60, count: 100_000 },
  };
}
