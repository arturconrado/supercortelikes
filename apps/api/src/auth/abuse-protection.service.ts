import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/env';

@Injectable()
export class AbuseProtectionService {
  private readonly required: boolean;
  private readonly secret?: string;
  private readonly bypassToken?: string;

  constructor(config: ConfigService<Environment, true>) {
    this.required = config.get('TURNSTILE_REQUIRED', { infer: true });
    this.secret = config.get('TURNSTILE_SECRET_KEY', { infer: true });
    this.bypassToken = config.get('TURNSTILE_BYPASS_TOKEN', { infer: true });
  }

  async verify(token: string | undefined, remoteIp?: string): Promise<void> {
    if (!this.required) return;
    if (this.bypassToken && token === this.bypassToken) return;
    if (!token || !this.secret) throw new UnauthorizedException('A verificação antiabuso é obrigatória.');
    const body = new URLSearchParams({ secret: this.secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => undefined) as { success?: boolean } | undefined;
    if (!response.ok || !payload?.success) throw new UnauthorizedException('A verificação antiabuso falhou.');
  }
}
