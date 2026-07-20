import { PayloadTooLargeException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { UsageService } from './usage.service';

const actor = { userId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', email: 'ana@clipbr.test' };
const config = (required = false) => ({
  get: vi.fn((key: string) => {
    if (key === 'EMAIL_VERIFICATION_REQUIRED') return required;
    if (key === 'ANALYTICS_CACHE_TTL_SECONDS') return 30;
    return undefined;
  }),
}) as any;
const aggregateSequence = (usedMinutes = 120, topUpMinutes = 0) => vi.fn()
  .mockResolvedValueOnce({ _sum: { quantity: new Prisma.Decimal(usedMinutes) } })
  .mockResolvedValueOnce({ _sum: { quantity: new Prisma.Decimal(topUpMinutes) } })
  .mockResolvedValue({ _sum: { quantity: new Prisma.Decimal(0) } });

function prisma(overrides: Record<string, unknown> = {}) {
  return {
    workspace: { findUnique: vi.fn().mockResolvedValue({ plan: 'PRO' }) },
    subscription: { findFirst: vi.fn().mockResolvedValue({ plan: 'PRO', status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 86_400_000), createdAt: new Date() }) },
    usageEvent: {
      aggregate: aggregateSequence(),
      upsert: vi.fn(),
    },
    user: { findUnique: vi.fn().mockResolvedValue({ emailVerifiedAt: new Date() }) },
    video: { findUnique: vi.fn().mockResolvedValue({ id: 'video', workspaceId: actor.workspaceId, ownerId: actor.userId, durationMs: 60_000n }) },
    ...overrides,
  } as any;
}

describe('UsageService', () => {
  it('returns the effective plan, limits and monthly usage', async () => {
    const service = new UsageService(prisma(), config());
    await expect(service.current(actor)).resolves.toMatchObject({
      plan: 'PRO',
      status: 'ACTIVE',
      usage: { minutes: 120, limit: 600, remaining: 480 },
      limits: { exportResolution: 'source', watermark: false },
    });
  });

  it('rejects unverified users only when the production flag is enabled', async () => {
    const service = new UsageService(prisma({ user: { findUnique: vi.fn().mockResolvedValue({ emailVerifiedAt: null }) } }), config(true));
    await expect(service.assertCanUpload(actor, 10n)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects uploads above the plan limit and videos above monthly quota', async () => {
    const service = new UsageService(prisma(), config());
    await expect(service.assertCanUpload(actor, BigInt(6 * 1024 ** 3))).rejects.toBeInstanceOf(PayloadTooLargeException);

    const overQuota = new UsageService(prisma({
      usageEvent: {
        aggregate: aggregateSequence(600, 0),
        upsert: vi.fn(),
      },
      video: { findUnique: vi.fn().mockResolvedValue({ id: 'video', workspaceId: actor.workspaceId, ownerId: actor.userId, durationMs: 60_000n }) },
    }), config());
    await expect(overQuota.assertCanProcessVideo('video')).rejects.toMatchObject({ status: 402 });
  });

  it('records processing minutes idempotently', async () => {
    const db = prisma();
    const service = new UsageService(db, config());
    await service.recordProcessingMinutes('video');
    expect(db.usageEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { idempotencyKey: 'processing.minutes:video' },
    }));
  });
});
