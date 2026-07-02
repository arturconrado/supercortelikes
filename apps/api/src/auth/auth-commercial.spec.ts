import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { AbuseProtectionService } from './abuse-protection.service';
import { AuthService } from './auth.service';

vi.mock('argon2', () => ({ argon2id: 2, hash: vi.fn().mockResolvedValue('new-hash'), verify: vi.fn().mockResolvedValue(true) }));

const configValues = {
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_DAYS: 30,
  REFRESH_TOKEN_SECRET: 'refresh-secret-at-least-32-characters',
  TERMS_VERSION: 'terms-2026-06',
  PRIVACY_VERSION: 'privacy-2026-06',
  PUBLIC_APP_URL: 'https://picashorts.com',
};
const config = (values: Record<string, unknown> = {}) => ({ get: vi.fn((key: string) => ({ ...configValues, ...values })[key]) }) as any;

afterEach(() => vi.unstubAllGlobals());

describe('AbuseProtectionService', () => {
  it('skips verification when disabled and accepts a bypass token', async () => {
    await expect(new AbuseProtectionService(config({ TURNSTILE_REQUIRED: false })).verify(undefined)).resolves.toBeUndefined();
    await expect(new AbuseProtectionService(config({ TURNSTILE_REQUIRED: true, TURNSTILE_BYPASS_TOKEN: 'bypass' })).verify('bypass')).resolves.toBeUndefined();
  });

  it('rejects missing or failed Turnstile tokens and accepts valid ones', async () => {
    const service = new AbuseProtectionService(config({ TURNSTILE_REQUIRED: true, TURNSTILE_SECRET_KEY: 'secret' }));
    await expect(service.verify(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ success: false }) }));
    await expect(service.verify('bad-token')).rejects.toBeInstanceOf(UnauthorizedException);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) }));
    await expect(service.verify('good-token', '127.0.0.1')).resolves.toBeUndefined();
  });
});

describe('AuthService commercial flows', () => {
  it('requires current legal versions at registration', async () => {
    const service = new AuthService({} as any, { signAsync: vi.fn() } as any, config());
    await expect(service.register({
      email: 'ana@clipbr.test',
      displayName: 'Ana',
      password: 'Password12345',
      acceptedTermsVersion: 'old',
      acceptedPrivacyVersion: 'privacy-2026-06',
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('verifies email tokens and rejects expired tokens', async () => {
    const tokenRecord = { id: 'token-id', userId: 'user-id', usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
    const prisma: any = {
      emailVerificationToken: {
        findUnique: vi.fn().mockResolvedValueOnce(tokenRecord).mockResolvedValueOnce({ ...tokenRecord, expiresAt: new Date(0) }),
        update: vi.fn(),
      },
      user: { update: vi.fn() },
      auditLog: { create: vi.fn() },
      $transaction: vi.fn(async (values: unknown[]) => Promise.all(values)),
    };
    const service = new AuthService(prisma, { signAsync: vi.fn() } as any, config());
    await service.verifyEmail('verification-token');
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { emailVerifiedAt: expect.any(Date) } }));
    await expect(service.verifyEmail('expired-token')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('sends reset emails defensively and resets passwords once', async () => {
    const reset = { id: 'reset-id', userId: 'user-id', usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
    const prisma: any = {
      user: {
        findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'user-id', email: 'ana@clipbr.test' }).mockResolvedValue({ id: 'user-id' }),
        update: vi.fn(),
      },
      passwordResetToken: { create: vi.fn(), findUnique: vi.fn().mockResolvedValue(reset), update: vi.fn() },
      refreshSession: { updateMany: vi.fn() },
      auditLog: { create: vi.fn() },
      $transaction: vi.fn(async (values: unknown[]) => Promise.all(values)),
    };
    const email = { send: vi.fn() };
    const service = new AuthService(prisma, { signAsync: vi.fn() } as any, config(), email as any);
    await service.forgotPassword({ email: 'missing@clipbr.test' });
    await service.forgotPassword({ email: 'ana@clipbr.test' });
    expect(email.send).toHaveBeenCalled();
    await service.resetPassword({ token: 'reset-token', password: 'Password12345' });
    expect(prisma.refreshSession.updateMany).toHaveBeenCalled();
  });
});
