import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Plan, type SubscriptionStatus } from '@prisma/client';
import type { Environment } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { CheckoutDto, TopUpDto } from './billing.dto';
import { PUBLIC_PLANS } from '../usage/entitlements';
import { UsageService } from '../usage/usage.service';

const priceByPlan: Record<'PRO' | 'BUSINESS', number> = { PRO: 59, BUSINESS: 149 };
const topUpCentsPerMinute = 39;

interface MercadoPagoResource {
  id?: string | number;
  status?: string;
  init_point?: string;
  point_of_interaction?: { transaction_data?: { qr_code?: string; qr_code_base64?: string; ticket_url?: string } };
  external_reference?: string;
}

@Injectable()
export class BillingService {
  private readonly accessToken?: string;
  private readonly webhookSecret?: string;
  private readonly appUrl: string;
  private readonly apiUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    config: ConfigService<Environment, true>,
  ) {
    this.accessToken = config.get('MERCADO_PAGO_ACCESS_TOKEN', { infer: true });
    this.webhookSecret = config.get('MERCADO_PAGO_WEBHOOK_SECRET', { infer: true });
    this.appUrl = config.get('PUBLIC_APP_URL', { infer: true });
    this.apiUrl = config.get('PUBLIC_API_URL', { infer: true });
  }

  plans(): unknown {
    return PUBLIC_PLANS;
  }

  async checkout(user: AuthenticatedUser, input: CheckoutDto, idempotencyKey: string): Promise<Record<string, unknown>> {
    this.assertIdempotencyKey(idempotencyKey);
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: user.workspaceId, members: { some: { userId: user.userId, role: { in: ['OWNER', 'ADMIN'] } } } },
    });
    if (!workspace) throw new UnauthorizedException('Only workspace owners and admins can manage billing');
    const previous = await this.prisma.billingCheckout.findUnique({ where: { idempotencyKey } });
    if (previous) {
      if (previous.workspaceId !== workspace.id || previous.plan !== input.plan || previous.method !== input.method) {
        throw new ConflictException('Idempotency-Key was already used for a different checkout');
      }
      return previous.response as Record<string, unknown>;
    }
    const reference = `${workspace.id}:${input.plan}`;
    let result: Record<string, unknown>;
    let providerResourceId: string | undefined;
    if (input.method === 'PIX') {
      const payment = await this.request<MercadoPagoResource>('/v1/payments', {
        transaction_amount: priceByPlan[input.plan],
        description: `PicaShorts ${input.plan} - 30 dias`,
        payment_method_id: 'pix',
        external_reference: reference,
        notification_url: `${this.apiUrl}/api/mercado-pago/webhook`,
        payer: {
          email: user.email,
          ...(input.document
            ? { identification: { type: input.document.length === 11 ? 'CPF' : 'CNPJ', number: input.document } }
            : {}),
        },
      }, 'POST', idempotencyKey);
      if (!payment.id) throw new ServiceUnavailableException('Mercado Pago did not return a payment id');
      providerResourceId = String(payment.id);
      await this.persistPending(workspace.id, input.plan, providerResourceId);
      result = {
        provider: 'mercado_pago',
        method: 'PIX',
        paymentId: providerResourceId,
        status: payment.status,
        qrCode: payment.point_of_interaction?.transaction_data?.qr_code,
        qrCodeBase64: payment.point_of_interaction?.transaction_data?.qr_code_base64,
        ticketUrl: payment.point_of_interaction?.transaction_data?.ticket_url,
      };
    } else {
      const subscription = await this.request<MercadoPagoResource>('/preapproval', {
        reason: `PicaShorts ${input.plan}`,
        external_reference: reference,
        payer_email: user.email,
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: priceByPlan[input.plan],
          currency_id: 'BRL',
        },
        back_url: `${this.appUrl}/settings/billing`,
        status: 'pending',
      }, 'POST', idempotencyKey);
      if (!subscription.id) throw new ServiceUnavailableException('Mercado Pago did not return a subscription id');
      providerResourceId = String(subscription.id);
      await this.persistPending(workspace.id, input.plan, providerResourceId);
      result = {
        provider: 'mercado_pago',
        method: 'CARD',
        subscriptionId: providerResourceId,
        status: subscription.status,
        checkoutUrl: subscription.init_point,
      };
    }
    await this.prisma.billingCheckout.create({
      data: {
        workspaceId: workspace.id,
        idempotencyKey,
        plan: input.plan,
        method: input.method,
        providerResourceId,
        status: String(result.status ?? 'pending'),
        response: result as Prisma.InputJsonObject,
      },
    });
    return result;
  }

  async topUp(user: AuthenticatedUser, input: TopUpDto, idempotencyKey: string): Promise<Record<string, unknown>> {
    this.assertIdempotencyKey(idempotencyKey);
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: user.workspaceId, members: { some: { userId: user.userId, role: { in: ['OWNER', 'ADMIN'] } } } },
    });
    if (!workspace) throw new UnauthorizedException('Only workspace owners and admins can buy top-ups');
    const previous = await this.prisma.creditTopUp.findUnique({ where: { idempotencyKey } });
    if (previous) {
      if (previous.workspaceId !== workspace.id || previous.minutes !== input.minutes) {
        throw new ConflictException('Idempotency-Key was already used for a different top-up');
      }
      return previous.response as Record<string, unknown>;
    }
    const amountCents = Math.max(1_900, input.minutes * topUpCentsPerMinute);
    const method = input.method ?? 'PIX';
    const reference = `topup:${workspace.id}:${input.minutes}`;
    let result: Record<string, unknown>;
    let providerResourceId: string | undefined;
    if (method === 'PIX') {
      const payment = await this.request<MercadoPagoResource>('/v1/payments', {
        transaction_amount: amountCents / 100,
        description: `PicaShorts top-up - ${input.minutes} minutos`,
        payment_method_id: 'pix',
        external_reference: reference,
        notification_url: `${this.apiUrl}/api/mercado-pago/webhook`,
        payer: {
          email: user.email,
          ...(input.document
            ? { identification: { type: input.document.length === 11 ? 'CPF' : 'CNPJ', number: input.document } }
            : {}),
        },
      }, 'POST', idempotencyKey);
      if (!payment.id) throw new ServiceUnavailableException('Mercado Pago did not return a payment id');
      providerResourceId = String(payment.id);
      result = {
        provider: 'mercado_pago',
        method,
        paymentId: providerResourceId,
        status: payment.status,
        minutes: input.minutes,
        amountCents,
        qrCode: payment.point_of_interaction?.transaction_data?.qr_code,
        qrCodeBase64: payment.point_of_interaction?.transaction_data?.qr_code_base64,
        ticketUrl: payment.point_of_interaction?.transaction_data?.ticket_url,
      };
    } else {
      const preference = await this.request<MercadoPagoResource>('/checkout/preferences', {
        external_reference: reference,
        notification_url: `${this.apiUrl}/api/mercado-pago/webhook`,
        back_urls: { success: `${this.appUrl}/settings/billing`, failure: `${this.appUrl}/settings/billing` },
        items: [
          {
            title: `PicaShorts top-up - ${input.minutes} minutos`,
            quantity: 1,
            currency_id: 'BRL',
            unit_price: amountCents / 100,
          },
        ],
        payer: { email: user.email },
      }, 'POST', idempotencyKey);
      if (!preference.id) throw new ServiceUnavailableException('Mercado Pago did not return a checkout id');
      providerResourceId = String(preference.id);
      result = {
        provider: 'mercado_pago',
        method,
        checkoutId: providerResourceId,
        checkoutUrl: preference.init_point,
        status: preference.status ?? 'pending',
        minutes: input.minutes,
        amountCents,
      };
    }
    await this.prisma.creditTopUp.create({
      data: {
        workspaceId: workspace.id,
        idempotencyKey,
        minutes: input.minutes,
        amountCents,
        providerResourceId,
        status: String(result.status ?? 'pending'),
        response: result as Prisma.InputJsonObject,
      },
    });
    return result;
  }

  async current(user: AuthenticatedUser): Promise<unknown> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { workspaceId: user.workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    const usage = await this.usage.current(user);
    return {
      ...(subscription ?? { plan: usage.plan, status: usage.status }),
      plan: subscription?.plan ?? usage.plan,
      status: subscription?.status ?? usage.status,
      usage,
      limits: usage.limits,
      graceUntil: usage.graceUntil,
      version: usage.version,
    };
  }

  async cancel(user: AuthenticatedUser): Promise<void> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { workspaceId: user.workspaceId, status: { in: ['ACTIVE', 'PENDING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!subscription) throw new NotFoundException('Active subscription not found');
    if (subscription.providerSubscriptionId) {
      await this.request(`/preapproval/${subscription.providerSubscriptionId}`, { status: 'canceled' }, 'PUT');
    }
    await this.prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: 'CANCELLED', cancelAtPeriodEnd: true },
    });
  }

  verifyWebhook(signature: string | undefined, requestId: string | undefined, dataId: string): void {
    if (!this.webhookSecret) throw new ServiceUnavailableException('Mercado Pago webhook secret is not configured');
    if (!signature || !requestId) throw new UnauthorizedException('Webhook signature headers are required');
    const parts = Object.fromEntries(signature.split(',').map((part) => part.trim().split('=', 2)));
    if (!parts.ts || !parts.v1) throw new UnauthorizedException('Webhook signature is malformed');
    if (Math.abs(Date.now() - Number(parts.ts)) > 5 * 60 * 1000) throw new UnauthorizedException('Webhook signature expired');
    const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
    const expected = createHmac('sha256', this.webhookSecret).update(manifest).digest('hex');
    const provided = Buffer.from(parts.v1, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) {
      throw new UnauthorizedException('Webhook signature is invalid');
    }
  }

  async processWebhook(type: string, dataId: string): Promise<void> {
    const providerEventId = `${type}:${dataId}`;
    const created = await this.prisma.billingWebhookEvent.createMany({
      data: {
        providerEventId,
        providerResourceId: dataId,
        eventType: type,
        status: 'PROCESSING',
      },
      skipDuplicates: true,
    });
    if (created.count === 0) {
      const existing = await this.prisma.billingWebhookEvent.findUnique({ where: { providerEventId } });
      if (existing?.status !== 'FAILED') return;
      await this.prisma.billingWebhookEvent.update({
        where: { providerEventId },
        data: { status: 'PROCESSING', lastError: null },
      });
    }
    const endpoint = type.includes('subscription') || type.includes('preapproval') ? `/preapproval/${dataId}` : `/v1/payments/${dataId}`;
    try {
      const resource = await this.request<MercadoPagoResource>(endpoint, undefined, 'GET');
      if (!resource.external_reference) throw new BadRequestException('Mercado Pago resource has no external reference');
      const reference = resource.external_reference.split(':');
      if (reference[0] === 'topup') {
        await this.processTopUpWebhook(providerEventId, resource, dataId);
        return;
      }
      const [workspaceId, planValue] = reference;
      if (!workspaceId || (planValue !== 'PRO' && planValue !== 'BUSINESS')) {
        throw new BadRequestException('Mercado Pago external reference is invalid');
      }
      const status = mapStatus(resource.status);
      const periodEnd = status === 'ACTIVE' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : undefined;
      await this.prisma.$transaction([
        this.prisma.subscription.upsert({
          where: { providerSubscriptionId: String(resource.id ?? dataId) },
          create: {
            workspaceId,
            plan: planValue,
            status,
            providerSubscriptionId: String(resource.id ?? dataId),
            currentPeriodStart: status === 'ACTIVE' ? new Date() : undefined,
            currentPeriodEnd: periodEnd,
          },
          update: {
            status,
            currentPeriodEnd: periodEnd,
            ...(status === 'ACTIVE' ? { currentPeriodStart: new Date() } : {}),
          },
        }),
        this.prisma.workspace.update({
          where: { id: workspaceId },
          data: { plan: status === 'ACTIVE' ? planValue : 'FREE' },
        }),
        this.prisma.billingWebhookEvent.update({
          where: { providerEventId },
          data: { status: 'PROCESSED', processedAt: new Date(), payload: resource as Prisma.InputJsonObject },
        }),
      ]);
    } catch (error) {
      await this.prisma.billingWebhookEvent.update({
        where: { providerEventId },
        data: { status: 'FAILED', lastError: error instanceof Error ? error.message.slice(0, 500) : 'Webhook failed' },
      });
      throw error;
    }
  }

  private async persistPending(workspaceId: string, plan: Plan, providerId: string): Promise<void> {
    await this.prisma.subscription.upsert({
      where: { providerSubscriptionId: providerId },
      create: { workspaceId, plan, providerSubscriptionId: providerId },
      update: { plan, status: 'PENDING' },
    });
  }

  private async processTopUpWebhook(providerEventId: string, resource: MercadoPagoResource, dataId: string): Promise<void> {
    const [, workspaceId, minutesValue] = String(resource.external_reference ?? '').split(':');
    const minutes = Number(minutesValue);
    if (!workspaceId || !Number.isInteger(minutes) || minutes <= 0) {
      throw new BadRequestException('Mercado Pago top-up reference is invalid');
    }
    const providerResourceId = String(resource.id ?? dataId);
    const status = mapStatus(resource.status);
    const topUp = await this.prisma.creditTopUp.findFirst({
      where: { providerResourceId, workspaceId },
    });
    if (!topUp) throw new NotFoundException('Top-up checkout not found');
    const operations: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.creditTopUp.update({
        where: { id: topUp.id },
        data: {
          status,
          response: resource as Prisma.InputJsonObject,
        },
      }),
      this.prisma.billingWebhookEvent.update({
        where: { providerEventId },
        data: { status: 'PROCESSED', processedAt: new Date(), payload: resource as Prisma.InputJsonObject },
      }),
    ];
    if (status === 'ACTIVE') {
      operations.push(
        this.prisma.usageEvent.upsert({
          where: { idempotencyKey: `billing.top_up.minutes:${topUp.id}` },
          create: {
            idempotencyKey: `billing.top_up.minutes:${topUp.id}`,
            workspaceId,
            type: 'billing.top_up.minutes',
            quantity: new Prisma.Decimal(topUp.minutes),
            unit: 'minute',
            costCents: topUp.amountCents,
            metadata: { topUpId: topUp.id, providerResourceId },
          },
          update: {},
        }),
      );
    }
    await this.prisma.$transaction(operations);
  }

  private async request<T>(path: string, body?: unknown, method = 'POST', idempotencyKey?: string): Promise<T> {
    if (!this.accessToken) throw new ServiceUnavailableException('Mercado Pago is not configured');
    const response = await fetch(`https://api.mercadopago.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
        'x-idempotency-key': idempotencyKey ?? `picashorts-${Date.now()}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json()) as T & { message?: string };
    if (!response.ok) throw new ServiceUnavailableException(payload.message ?? 'Mercado Pago request failed');
    return payload;
  }

  private assertIdempotencyKey(key: string): void {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw new BadRequestException('Idempotency-Key must contain 8-128 safe ASCII characters');
    }
  }
}

function mapStatus(status?: string): SubscriptionStatus {
  if (status === 'approved' || status === 'authorized') return 'ACTIVE';
  if (status === 'canceled' || status === 'cancelled' || status === 'cancelled_by_user') return 'CANCELLED';
  if (status === 'paused' || status === 'past_due') return 'PAST_DUE';
  if (status === 'expired') return 'EXPIRED';
  return 'PENDING';
}
