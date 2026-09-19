import { describe, expect, it, vi } from 'vitest';
import { OfferProductionProcessorService } from './offer-production-processor.service';
import type { OfferProductionJob } from './offer-production.constants';

const baseJob: OfferProductionJob = {
  schemaVersion: 1,
  eventId: '11111111-1111-4111-8111-111111111111',
  launchRunId: '22222222-2222-4222-8222-222222222222',
  stageExecutionId: '33333333-3333-4333-8333-333333333333',
  opportunityId: '44444444-4444-4444-8444-444444444444',
  productId: '55555555-5555-4555-8555-555555555555',
  workspaceId: '66666666-6666-4666-8666-666666666666',
  stage: 'OFFER',
  correlationId: '22222222-2222-4222-8222-222222222222',
  causationId: '22222222-2222-4222-8222-222222222222',
  occurredAt: '2026-09-15T00:00:00.000Z',
};

function prismaFixture() {
  return {
    offerProductionStageExecution: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(async () => ({ id: '44444444-4444-4444-8444-555555555555', stage: 'MEDIA_ASSETS' })),
      update: vi.fn(async (args) => ({ id: args.where.id, ...args.data })),
    },
    digitalProduct: {
      findUniqueOrThrow: vi.fn(async () => ({ id: baseJob.productId, title: 'Oferta pronta', status: 'READY', offerType: 'PRODUCT' })),
    },
    marketOpportunity: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: baseJob.opportunityId,
        title: 'Planilha de precificacao',
        audience: 'Confeiteiras MEI',
        pain: 'Dificuldade de precificar sem prejuizo.',
        category: 'Financas',
        format: 'Planilha',
        offerType: 'PRODUCT',
      })),
    },
    offerMediaAsset: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async (args) => ({ count: args.data.length })),
      findMany: vi.fn(async () => [
        { id: 'asset-1', kind: 'LANDING_PAGE', title: 'Pagina', channel: 'web', body: {}, objective: 'Converter' },
        { id: 'asset-2', kind: 'SHORT_VIDEO', title: 'Video', channel: 'reels', body: {}, objective: 'Atrair' },
      ]),
      count: vi.fn(async () => 2),
    },
    offerPublicationDraft: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async (args) => ({ count: args.data.length })),
      findMany: vi.fn(async () => [{ id: 'draft-1', provider: 'manual_email' }]),
      count: vi.fn(async () => 1),
    },
    offerProductionOutboxEvent: {
      create: vi.fn(async (args) => ({ id: args.data.id, ...args.data })),
    },
    offerLaunchRun: {
      update: vi.fn(async (args) => ({ id: args.where.id, ...args.data })),
    },
    $transaction: vi.fn(async (operations) => Promise.all(operations)),
  };
}

describe('OfferProductionProcessorService', () => {
  it('completes one stage and schedules the next stage through the offer outbox', async () => {
    const prisma = prismaFixture();
    const service = new OfferProductionProcessorService(prisma as never);

    await service.process(baseJob);

    expect(prisma.offerProductionStageExecution.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: baseJob.stageExecutionId, stage: 'OFFER' }),
      data: expect.objectContaining({ status: 'PROCESSING' }),
    }));
    expect(prisma.offerProductionOutboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        launchRunId: baseJob.launchRunId,
        type: 'offer.production.offer.completed.v1',
        payload: expect.objectContaining({
          stage: 'MEDIA_ASSETS',
          stageExecutionId: '44444444-4444-4444-8444-555555555555',
          causationId: baseJob.eventId,
        }),
      }),
    }));
  });

  it('marks the launch as review required after the metrics setup stage', async () => {
    const prisma = prismaFixture();
    const service = new OfferProductionProcessorService(prisma as never);

    await service.process({ ...baseJob, stage: 'METRICS_SETUP' });

    expect(prisma.offerProductionOutboxEvent.create).not.toHaveBeenCalled();
    expect(prisma.offerLaunchRun.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: baseJob.launchRunId },
      data: expect.objectContaining({
        status: 'REVIEW_REQUIRED',
        result: expect.objectContaining({
          productId: baseJob.productId,
          mediaAssets: 2,
          publicationDrafts: 1,
        }),
      }),
    }));
  });
});
