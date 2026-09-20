import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { type OfferProductionStageName } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { buildMediaAssets, buildPublicationDrafts, toJson } from '../opportunities/opportunities.service';
import { safeErrorMessage } from '../queues/pipeline-orchestrator.service';
import {
  completedOfferProductionEventType,
  nextOfferProductionStage,
  type OfferProductionJob,
  type OfferProductionStage,
} from './offer-production.constants';

@Injectable()
export class OfferProductionProcessorService {
  constructor(private readonly prisma: PrismaService) {}

  async process(job: OfferProductionJob): Promise<void> {
    const stage = job.stage as OfferProductionStageName;
    const claimed = await this.prisma.offerProductionStageExecution.updateMany({
      where: { id: job.stageExecutionId, launchRunId: job.launchRunId, stage, status: { in: ['QUEUED', 'PENDING', 'RETRYING'] } },
      data: { status: 'PROCESSING', attempts: { increment: 1 }, startedAt: new Date(), errorCode: null, errorMessage: null },
    });
    if (claimed.count !== 1) {
      const current = await this.prisma.offerProductionStageExecution.findUnique({ where: { id: job.stageExecutionId } });
      if (current?.status === 'SUCCEEDED') return;
      throw new UnrecoverableError(`Offer production stage ${job.stage} is not claimable`);
    }

    try {
      const output = await this.runStage(job);
      await this.complete(job, output);
    } catch (error) {
      await this.fail(job, error);
      throw error;
    }
  }

  private async runStage(job: OfferProductionJob): Promise<unknown> {
    const product = await this.prisma.digitalProduct.findUniqueOrThrow({ where: { id: job.productId } });
    const opportunity = await this.prisma.marketOpportunity.findUniqueOrThrow({ where: { id: job.opportunityId } });

    if (job.stage === 'OFFER') {
      return { productId: product.id, title: product.title, status: product.status, offerType: product.offerType };
    }

    if (job.stage === 'MEDIA_ASSETS') {
      const assets = buildMediaAssets(product.id, job.workspaceId, opportunity);
      await this.prisma.$transaction([
        this.prisma.offerMediaAsset.deleteMany({ where: { productId: product.id, workspaceId: job.workspaceId } }),
        this.prisma.offerMediaAsset.createMany({ data: assets }),
      ]);
      const created = await this.prisma.offerMediaAsset.findMany({
        where: { productId: product.id, workspaceId: job.workspaceId },
        orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
      });
      return { count: created.length, kinds: [...new Set(created.map((asset) => asset.kind))] };
    }

    if (job.stage === 'PUBLICATION_DRAFTS') {
      const assets = await this.prisma.offerMediaAsset.findMany({ where: { productId: product.id, workspaceId: job.workspaceId } });
      const drafts = buildPublicationDrafts(product.id, job.workspaceId, assets);
      await this.prisma.$transaction([
        this.prisma.offerPublicationDraft.deleteMany({ where: { productId: product.id, workspaceId: job.workspaceId } }),
        this.prisma.offerPublicationDraft.createMany({ data: drafts }),
      ]);
      const created = await this.prisma.offerPublicationDraft.findMany({
        where: { productId: product.id, workspaceId: job.workspaceId },
        orderBy: [{ channel: 'asc' }, { createdAt: 'asc' }],
      });
      return { count: created.length, providers: [...new Set(created.map((draft) => draft.provider))] };
    }

    return {
      tracking: 'manual_snapshot_ready',
      requiredMetrics: ['impressions', 'clicks', 'leads', 'sales', 'revenueCents', 'costCents'],
      safetyGate: ['publish', 'schedule', 'checkout_submit'],
    };
  }

  private async complete(job: OfferProductionJob, output: unknown): Promise<void> {
    const nextStage = nextOfferProductionStage(job.stage as OfferProductionStage);
    const completedAt = new Date();
    if (!nextStage) {
      const [mediaAssets, publicationDrafts] = await Promise.all([
        this.prisma.offerMediaAsset.count({ where: { productId: job.productId, workspaceId: job.workspaceId } }),
        this.prisma.offerPublicationDraft.count({ where: { productId: job.productId, workspaceId: job.workspaceId } }),
      ]);
      await this.prisma.$transaction([
        this.prisma.offerProductionStageExecution.update({
          where: { id: job.stageExecutionId },
          data: { status: 'SUCCEEDED', completedAt, output: toJson(output), errorCode: null, errorMessage: null },
        }),
        this.prisma.offerLaunchRun.update({
          where: { id: job.launchRunId },
          data: {
            status: 'REVIEW_REQUIRED',
            steps: [
              { name: 'gate_humano', status: 'OK', detail: 'Oportunidade aprovada.' },
              { name: 'oferta', status: 'OK', detail: 'Oferta pronta para validacao.' },
              { name: 'midias', status: 'OK', detail: `${mediaAssets} assets disponiveis.` },
              { name: 'publicacao', status: 'REVIEW_REQUIRED', detail: `${publicationDrafts} drafts criados; publicacao real exige aprovacao/credenciais.` },
              { name: 'metricas', status: 'READY', detail: 'Snapshots podem ser enviados manualmente ou por integracao futura.' },
            ],
            result: {
              productId: job.productId,
              mediaAssets,
              publicationDrafts,
              blockedUntilHumanApproval: ['publish', 'schedule', 'checkout_submit'],
            },
          },
        }),
      ]);
      return;
    }

    const nextExecution = await this.prisma.offerProductionStageExecution.findUniqueOrThrow({
      where: { launchRunId_stage: { launchRunId: job.launchRunId, stage: nextStage as OfferProductionStageName } },
    });
    const eventId = randomUUID();
    const nextJob: OfferProductionJob = {
      ...job,
      eventId,
      stageExecutionId: nextExecution.id,
      stage: nextStage,
      causationId: job.eventId,
      occurredAt: completedAt.toISOString(),
    };
    await this.prisma.$transaction([
      this.prisma.offerProductionStageExecution.update({
        where: { id: job.stageExecutionId },
        data: { status: 'SUCCEEDED', completedAt, output: toJson(output), errorCode: null, errorMessage: null },
      }),
      this.prisma.offerProductionOutboxEvent.create({
        data: {
          id: eventId,
          launchRunId: job.launchRunId,
          type: completedOfferProductionEventType(job.stage as OfferProductionStage),
          payload: nextJob,
        },
      }),
    ]);
  }

  private async fail(job: OfferProductionJob, error: unknown): Promise<void> {
    const message = safeErrorMessage(error);
    await this.prisma.$transaction([
      this.prisma.offerProductionStageExecution.update({
        where: { id: job.stageExecutionId },
        data: { status: 'FAILED', completedAt: new Date(), errorCode: 'OFFER_STAGE_FAILED', errorMessage: message },
      }),
      this.prisma.offerLaunchRun.update({
        where: { id: job.launchRunId },
        data: { status: 'FAILED', errorMessage: message },
      }),
    ]);
  }
}
