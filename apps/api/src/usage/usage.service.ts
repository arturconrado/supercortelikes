import { HttpException, Injectable, PayloadTooLargeException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Plan, type Subscription } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { TtlCache } from '../common/ttl-cache';
import type { Environment } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { commercialPlan, limitsFor, PLAN_VERSION, type CommercialPlan, type PlanLimits } from './entitlements';

export interface UsageSnapshot {
  plan: CommercialPlan;
  status: 'ACTIVE' | 'GRACE' | 'FREE' | 'BLOCKED';
  version: string;
  periodStart: string;
  periodEnd: string;
  graceUntil?: string;
  usage: {
    minutes: number;
    topUpMinutes: number;
    limit: number;
    remaining: number;
  };
  limits: PlanLimits;
}

@Injectable()
export class UsageService {
  private readonly emailVerificationRequired: boolean;
  private readonly currentCache: TtlCache<UsageSnapshot>;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Environment, true>,
  ) {
    this.emailVerificationRequired = config.get('EMAIL_VERIFICATION_REQUIRED', { infer: true });
    this.currentCache = new TtlCache(config.get('ANALYTICS_CACHE_TTL_SECONDS', { infer: true }) * 1000);
  }

  async current(actor: AuthenticatedUser): Promise<UsageSnapshot> {
    const cached = this.currentCache.get(actor.workspaceId);
    if (cached) return cached;
    const snapshot = await this.snapshot(actor.workspaceId);
    this.currentCache.set(actor.workspaceId, snapshot);
    return snapshot;
  }

  invalidateWorkspace(workspaceId: string): void {
    this.currentCache.delete(workspaceId);
  }

  async snapshot(workspaceId: string, now = new Date()): Promise<UsageSnapshot> {
    const [workspace, subscription] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } }),
      this.prisma.subscription.findFirst({ where: { workspaceId }, orderBy: { createdAt: 'desc' } }),
    ]);
    if (!workspace) throw new UnauthorizedException('Workspace is no longer available');
    const effective = this.effectivePlan(workspace.plan, subscription, now);
    const limits = limitsFor(effective.plan);
    const periodStart = startOfMonth(now);
    const periodEnd = startOfNextMonth(now);
    const [usage, topUps] = await Promise.all([
      this.prisma.usageEvent.aggregate({
        where: {
          workspaceId,
          type: 'processing.minutes',
          createdAt: { gte: periodStart, lt: periodEnd },
        },
        _sum: { quantity: true },
      }),
      this.prisma.usageEvent.aggregate({
        where: {
          workspaceId,
          type: 'billing.top_up.minutes',
          createdAt: { gte: periodStart, lt: periodEnd },
        },
        _sum: { quantity: true },
      }),
    ]);
    const used = decimalToNumber(usage._sum.quantity);
    const topUpMinutes = decimalToNumber(topUps._sum.quantity);
    const limit = limits.minutesPerMonth + topUpMinutes;
    return {
      plan: effective.plan,
      status: effective.status,
      version: PLAN_VERSION,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      ...(effective.graceUntil ? { graceUntil: effective.graceUntil.toISOString() } : {}),
      usage: {
        minutes: roundUsage(used),
        topUpMinutes: roundUsage(topUpMinutes),
        limit,
        remaining: roundUsage(Math.max(0, limit - used)),
      },
      limits,
    };
  }

  async assertCanUpload(actor: AuthenticatedUser, expectedSizeBytes: bigint): Promise<UsageSnapshot> {
    await this.assertEmailVerified(actor.userId);
    const snapshot = await this.snapshot(actor.workspaceId);
    if (snapshot.status === 'BLOCKED') throw paymentRequired('Sua assinatura precisa ser regularizada para processar novos vídeos.');
    if (snapshot.usage.remaining <= 0) throw paymentRequired('Seu limite mensal de processamento foi atingido.');
    if (expectedSizeBytes > BigInt(snapshot.limits.maxUploadBytes)) {
      throw new PayloadTooLargeException('O arquivo excede o limite do plano atual.');
    }
    return snapshot;
  }

  async assertCanProcessVideo(videoId: string): Promise<UsageSnapshot> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true, workspaceId: true, ownerId: true, durationMs: true },
    });
    if (!video?.workspaceId) throw new UnauthorizedException('Video has no active workspace');
    if (video.ownerId) await this.assertEmailVerified(video.ownerId);
    const snapshot = await this.snapshot(video.workspaceId);
    if (snapshot.status === 'BLOCKED') throw paymentRequired('Assinatura expirada ou inadimplente.');
    const durationSeconds = Number(video.durationMs ?? 0n) / 1000;
    if (durationSeconds > snapshot.limits.maxVideoDurationSeconds) {
      throw paymentRequired('O vídeo excede a duração máxima do plano atual.');
    }
    const requestedMinutes = durationSeconds / 60;
    if (snapshot.usage.minutes + requestedMinutes > snapshot.usage.limit) {
      throw paymentRequired('Este processamento excede o limite mensal do plano atual.');
    }
    return snapshot;
  }

  async recordProcessingMinutes(videoId: string): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true, workspaceId: true, durationMs: true },
    });
    if (!video?.workspaceId || !video.durationMs) return;
    const quantity = new Prisma.Decimal(Number(video.durationMs) / 60_000);
    await this.prisma.usageEvent.upsert({
      where: { idempotencyKey: `processing.minutes:${videoId}` },
      create: {
        idempotencyKey: `processing.minutes:${videoId}`,
        workspaceId: video.workspaceId,
        videoId,
        type: 'processing.minutes',
        quantity,
        unit: 'minute',
        metadata: { source: 'pipeline.ingestion' },
      },
      update: { quantity },
    });
    this.currentCache.delete(video.workspaceId);
  }

  async queuePriorityForVideo(videoId: string): Promise<number> {
    const video = await this.prisma.video.findUnique({ where: { id: videoId }, select: { workspaceId: true } });
    if (!video?.workspaceId) return limitsFor('FREE').queuePriority;
    return (await this.snapshot(video.workspaceId)).limits.queuePriority;
  }

  private async assertEmailVerified(userId: string): Promise<void> {
    if (!this.emailVerificationRequired) return;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
    if (!user?.emailVerifiedAt) throw new UnauthorizedException('Verifique seu e-mail antes de enviar ou processar vídeos.');
  }

  private effectivePlan(workspacePlan: Plan, subscription: Subscription | null, now: Date): { plan: CommercialPlan; status: UsageSnapshot['status']; graceUntil?: Date } {
    if (!subscription) return { plan: commercialPlan(workspacePlan), status: commercialPlan(workspacePlan) === 'FREE' ? 'FREE' : 'ACTIVE' };
    if (subscription.status === 'ACTIVE') return { plan: commercialPlan(subscription.plan), status: 'ACTIVE' };
    const limits = limitsFor(subscription.plan);
    const graceUntil = subscription.currentPeriodEnd
      ? new Date(subscription.currentPeriodEnd.getTime() + limits.graceDays * 24 * 60 * 60 * 1000)
      : undefined;
    if (graceUntil && graceUntil > now && limits.graceDays > 0) {
      return { plan: commercialPlan(subscription.plan), status: 'GRACE', graceUntil };
    }
    return { plan: 'FREE', status: subscription.plan === 'FREE' ? 'FREE' : 'BLOCKED' };
  }
}

function startOfMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function startOfNextMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1));
}

function decimalToNumber(value: Prisma.Decimal | null | undefined): number {
  return value ? value.toNumber() : 0;
}

function roundUsage(value: number): number {
  return Math.round(value * 100) / 100;
}

function paymentRequired(message: string): HttpException {
  return new HttpException(message, 402);
}
