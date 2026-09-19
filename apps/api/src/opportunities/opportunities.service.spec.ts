import { ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpportunitiesService } from './opportunities.service';

const user = { userId: 'user-1', workspaceId: 'workspace-1', email: 'user@example.com' };

function prismaFixture() {
  return {
    marketOpportunity: {
      create: vi.fn(async (args) => ({ id: 'opp-1', ...args.data, signals: [], products: [] })),
      findFirst: vi.fn(),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      update: vi.fn(async (args) => ({ id: args.where.id, ...args.data, signals: [], products: [] })),
    },
    digitalProduct: {
      create: vi.fn(async (args) => ({ id: 'product-1', ...args.data })),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({ id: 'product-1', workspaceId: user.workspaceId, opportunityId: 'opp-1' })),
      findUniqueOrThrow: vi.fn(async () => ({ id: 'product-1', workspaceId: user.workspaceId, opportunityId: 'opp-1', title: 'Offer', mediaAssets: [{ kind: 'LANDING_PAGE', title: 'Page', channel: 'web', body: {}, objective: 'Convert' }], publicationDrafts: [] })),
    },
    offerMediaAsset: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async (args) => ({ count: args.data.length })),
      findMany: vi.fn(async () => [{ id: 'asset-1', kind: 'LANDING_PAGE', status: 'READY', title: 'Page', channel: 'web', body: {}, objective: 'Convert' }]),
      findFirst: vi.fn(async () => ({ id: 'asset-1', productId: 'product-1', workspaceId: user.workspaceId })),
      update: vi.fn(async (args) => ({ id: args.where.id, ...args.data })),
    },
    offerPublicationDraft: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async (args) => ({ count: args.data.length })),
      findMany: vi.fn(async () => [{ id: 'draft-1', status: 'READY' }]),
    },
    offerLaunchRun: {
      create: vi.fn(async (args) => ({
        id: 'launch-1',
        ...args.data,
        stages: [
          { id: 'stage-offer', stage: 'OFFER', status: 'PENDING' },
          { id: 'stage-media', stage: 'MEDIA_ASSETS', status: 'PENDING' },
          { id: 'stage-drafts', stage: 'PUBLICATION_DRAFTS', status: 'PENDING' },
          { id: 'stage-metrics', stage: 'METRICS_SETUP', status: 'PENDING' },
        ],
      })),
      update: vi.fn(async (args) => ({ id: args.where.id, ...args.data, stages: [{ stage: 'OFFER', status: 'SUCCEEDED' }] })),
    },
    offerProductionOutboxEvent: {
      create: vi.fn(async (args) => ({ id: args.data.id, ...args.data })),
    },
    offerProductionStageExecution: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async (args) => ({ id: 'stage-1', ...args.data })),
      findUnique: vi.fn(async () => ({ status: 'PENDING' })),
    },
    offerMetricSnapshot: {
      create: vi.fn(async (args) => ({ id: 'metric-1', ...args.data })),
    },
    auditLog: { create: vi.fn(async () => undefined) },
    $transaction: vi.fn(async (operations) => Promise.all(operations)),
  };
}

describe('OpportunitiesService', () => {
  let prisma: ReturnType<typeof prismaFixture>;
  let service: OpportunitiesService;

  beforeEach(() => {
    prisma = prismaFixture();
    service = new OpportunitiesService(prisma as never);
  });

  it('creates opportunities with deterministic weighted scoring', async () => {
    const result = await service.create(user, {
      title: 'Planilha para confeiteiras',
      audience: 'Confeiteiras MEI',
      pain: 'Nao conseguem calcular preco com margem e embalagem.',
      category: 'Financas',
      format: 'Planilha',
      demandScore: 80,
      saturationScore: 40,
      monetizationScore: 70,
      channelFitScore: 90,
      signals: [{ source: 'youtube', label: 'Muitas buscas por precificacao', strength: 82 }],
    }) as { score: number };

    expect(result.score).toBe(76);
    expect(prisma.marketOpportunity.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ workspaceId: user.workspaceId, createdById: user.userId, score: 76 }),
    }));
  });

  it('blocks advancing non-approved opportunities', async () => {
    prisma.marketOpportunity.findFirst.mockResolvedValueOnce({ id: 'opp-1', workspaceId: user.workspaceId, status: 'OBSERVING', gateDecision: 'PENDING' });

    await expect(service.advance(user, 'opp-1', { status: 'TESTING' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('generates a QA-scored product after approval', async () => {
    prisma.marketOpportunity.findFirst.mockResolvedValueOnce({
      id: 'opp-1',
      workspaceId: user.workspaceId,
      title: 'Kit WhatsApp',
      audience: 'Autonomos',
      pain: 'Dificuldade de fazer follow-up e fechar vendas.',
      format: 'Scripts',
      gateDecision: 'APPROVED',
    });

    const product = await service.generateProduct(user, 'opp-1') as { status: string; qualityScore: number; assets: { creativeAngles: string[] }; mediaAssets: unknown[] };

    expect(product.status).toBe('READY');
    expect(product.qualityScore).toBe(100);
    expect(product.assets.creativeAngles).toHaveLength(3);
    expect(product.mediaAssets.length).toBeGreaterThan(0);
  });

  it('queues the agentic launch pipeline', async () => {
    prisma.marketOpportunity.findFirst.mockResolvedValueOnce({
      id: 'opp-1',
      workspaceId: user.workspaceId,
      title: 'Kit WhatsApp',
      audience: 'Autonomos',
      pain: 'Dificuldade de follow-up.',
      category: 'Vendas',
      format: 'Scripts',
      offerType: 'SERVICE',
      gateDecision: 'APPROVED',
    });
    prisma.digitalProduct.findFirst.mockResolvedValueOnce({
      id: 'product-1',
      workspaceId: user.workspaceId,
      opportunityId: 'opp-1',
      title: 'Offer',
      mediaAssets: [{ kind: 'WHATSAPP_COPY', title: 'WhatsApp', channel: 'whatsapp', body: {}, objective: 'Convert' }],
      publicationDrafts: [],
    } as never);

    const result = await service.prepareLaunch(user, 'opp-1') as { launchRun: { status: string; stages: Array<{ status: string }> }; publicationDrafts: unknown[] };

    expect(result.launchRun.status).toBe('RUNNING');
    expect(result.launchRun.stages.every((stage) => stage.status === 'PENDING')).toBe(true);
    expect(prisma.offerProductionOutboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        launchRunId: 'launch-1',
        type: 'offer.production.requested.v1',
        payload: expect.objectContaining({ stage: 'OFFER', stageExecutionId: 'stage-offer' }),
      }),
    }));
  });
});
