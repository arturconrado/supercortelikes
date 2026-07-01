import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { BillingService } from './billing.service';

const user = { userId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', email: 'buyer@clipbr.test' };
const config = {
  get: vi.fn((key: string) => ({
    MERCADO_PAGO_ACCESS_TOKEN: 'mp-token',
    MERCADO_PAGO_WEBHOOK_SECRET: 'webhook-secret-123456',
    PUBLIC_APP_URL: 'https://app.clipbr.ai',
    PUBLIC_API_URL: 'https://api.clipbr.ai',
  }[key])),
} as any;

function fixture() {
  const prisma: any = {
    workspace: {
      findFirst: vi.fn().mockResolvedValue({ id: user.workspaceId }),
      update: vi.fn(),
    },
    billingCheckout: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    subscription: {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    },
    billingWebhookEvent: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ status: 'PROCESSED' }),
      update: vi.fn(),
    },
    $transaction: vi.fn(async (values: unknown[]) => Promise.all(values)),
  };
  const usage = { current: vi.fn().mockResolvedValue({ plan: 'FREE', status: 'FREE', limits: {}, usage: {}, version: 'test' }) };
  return { service: new BillingService(prisma, usage as any, config), prisma, usage };
}

describe('BillingService', () => {
  it('returns public plans with limits and version', () => {
    const { service } = fixture();
    expect(service.plans()).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'PRO', limits: expect.any(Object), version: expect.any(String) })]));
  });

  it('creates checkout once and returns an idempotent retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'sub-1', status: 'pending', init_point: 'https://mp/checkout' }) }));
    const { service, prisma } = fixture();
    await expect(service.checkout(user, { plan: 'PRO', method: 'CARD' }, 'checkout-1234')).resolves.toMatchObject({ checkoutUrl: 'https://mp/checkout' });
    expect(prisma.billingCheckout.create).toHaveBeenCalled();
    prisma.billingCheckout.findUnique.mockResolvedValueOnce({
      workspaceId: user.workspaceId,
      plan: 'PRO',
      method: 'CARD',
      response: { checkoutUrl: 'https://mp/checkout' },
    });
    await expect(service.checkout(user, { plan: 'PRO', method: 'CARD' }, 'checkout-1234')).resolves.toMatchObject({ checkoutUrl: 'https://mp/checkout' });
    prisma.billingCheckout.findUnique.mockResolvedValueOnce({ workspaceId: user.workspaceId, plan: 'BUSINESS', method: 'CARD', response: {} });
    await expect(service.checkout(user, { plan: 'PRO', method: 'CARD' }, 'checkout-1234')).rejects.toBeInstanceOf(ConflictException);
    vi.unstubAllGlobals();
  });

  it('deduplicates billing webhooks and rejects malformed provider references', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'payment-1', status: 'approved' }) }));
    const { service, prisma } = fixture();
    await expect(service.processWebhook('payment', 'payment-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.billingWebhookEvent.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }));
    prisma.billingWebhookEvent.createMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.processWebhook('payment', 'payment-1')).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
