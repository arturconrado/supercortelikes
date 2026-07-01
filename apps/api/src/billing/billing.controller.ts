import { BadRequestException, Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { CurrentUser, Public } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import { BillingService } from './billing.service';
import { CheckoutDto, TopUpDto } from './billing.dto';

@Controller()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Public()
  @Get('billing/plans')
  plans(): unknown {
    return this.billing.plans();
  }

  @Get('billing/subscription')
  async current(@CurrentUser() user: AuthenticatedUser): Promise<unknown> {
    return this.billing.current(user);
  }

  @Post('billing/checkout')
  async checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CheckoutDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<unknown> {
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header is required');
    return this.billing.checkout(user, input, idempotencyKey);
  }

  @Post('billing/top-ups')
  async topUp(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: TopUpDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<unknown> {
    if (!idempotencyKey) throw new BadRequestException('Idempotency-Key header is required');
    return this.billing.topUp(user, input, idempotencyKey);
  }

  @Post('billing/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.billing.cancel(user);
  }

  @Public()
  @Post('api/mercado-pago/webhook')
  @HttpCode(HttpStatus.NO_CONTENT)
  async webhook(
    @Headers('x-signature') signature: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
    @Query('data.id') queryDataId: string | undefined,
    @Query('type') queryType: string | undefined,
    @Body() body: { type?: string; data?: { id?: string | number } },
  ): Promise<void> {
    const dataId = String(body.data?.id ?? queryDataId ?? '');
    const type = body.type ?? queryType ?? 'payment';
    if (!dataId) return;
    this.billing.verifyWebhook(signature, requestId, dataId);
    await this.billing.processWebhook(type, dataId);
  }
}
