import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import type { Environment } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../notifications/email.service';
import type { AuthenticatedUser, AuthTokens } from './auth.types';
import type { ForgotPasswordDto, LoginDto, RegisterDto, ResetPasswordDto } from './auth.dto';

@Injectable()
export class AuthService {
  private readonly accessTtl: string;
  private readonly refreshDays: number;
  private readonly refreshSecret: string;
  private readonly termsVersion: string;
  private readonly privacyVersion: string;
  private readonly appUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    config: ConfigService<Environment, true>,
    @Optional() private readonly email?: EmailService,
  ) {
    this.accessTtl = config.get('JWT_ACCESS_TTL', { infer: true });
    this.refreshDays = config.get('JWT_REFRESH_DAYS', { infer: true });
    this.refreshSecret = config.get('REFRESH_TOKEN_SECRET', { infer: true }) ?? 'test-refresh-token-secret-at-least-32-characters';
    this.termsVersion = config.get('TERMS_VERSION', { infer: true });
    this.privacyVersion = config.get('PRIVACY_VERSION', { infer: true });
    this.appUrl = config.get('PUBLIC_APP_URL', { infer: true });
  }

  async register(input: RegisterDto): Promise<{ user: AuthenticatedUser & { displayName: string }; tokens: AuthTokens }> {
    if (input.acceptedTermsVersion !== this.termsVersion || input.acceptedPrivacyVersion !== this.privacyVersion) {
      throw new BadRequestException('Você precisa aceitar as versões atuais dos termos e da política de privacidade.');
    }
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const slugBase = input.displayName
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'workspace';
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            id: userId,
            email: input.email,
            displayName: input.displayName.trim(),
            passwordHash,
            acceptedTermsVersion: input.acceptedTermsVersion,
            acceptedPrivacyVersion: input.acceptedPrivacyVersion,
            termsAcceptedAt: new Date(),
            privacyAcceptedAt: new Date(),
          },
        });
        await tx.workspace.create({
          data: {
            id: workspaceId,
            ownerId: userId,
            name: `${created.displayName}'s workspace`,
            slug: `${slugBase}-${randomBytes(4).toString('hex')}`,
            members: { create: { userId, role: 'OWNER' } },
          },
        });
        await tx.auditLog.create({
          data: { userId, workspaceId, action: 'auth.register', resource: 'user', resourceId: userId },
        });
        return created;
      });
      const identity = { userId, workspaceId, email: user.email };
      await this.sendEmailVerification(user.id, user.email, user.displayName).catch(() => undefined);
      return { user: { ...identity, displayName: user.displayName }, tokens: await this.issueTokens(identity) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('An account with this email already exists');
      }
      throw error;
    }
  }

  async login(input: LoginDto): Promise<{ user: AuthenticatedUser & { displayName: string }; tokens: AuthTokens }> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      include: { memberships: { take: 1 }, ownedWorkspaces: { take: 1 } },
    });
    if (!user || !(await argon2.verify(user.passwordHash, input.password))) {
      throw new UnauthorizedException('Email or password is invalid');
    }
    const workspaceId = user.memberships[0]?.workspaceId ?? user.ownedWorkspaces[0]?.id;
    if (!workspaceId) throw new UnauthorizedException('The account has no active workspace');
    const identity = { userId: user.id, workspaceId, email: user.email };
    await this.prisma.auditLog.create({
      data: { userId: user.id, workspaceId, action: 'auth.login', resource: 'session' },
    });
    return { user: { ...identity, displayName: user.displayName }, tokens: await this.issueTokens(identity) };
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const tokenHash = this.hashToken(refreshToken);
    const session = await this.prisma.refreshSession.findUnique({
      where: { tokenHash },
      include: { user: { include: { memberships: { take: 1 }, ownedWorkspaces: { take: 1 } } } },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }
    await this.prisma.refreshSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    const workspaceId = session.user.memberships[0]?.workspaceId ?? session.user.ownedWorkspaces[0]?.id;
    if (!workspaceId) throw new UnauthorizedException('The account has no active workspace');
    return this.issueTokens({ userId: session.user.id, workspaceId, email: session.user.email });
  }

  async logout(refreshToken: string): Promise<void> {
    await this.prisma.refreshSession.updateMany({
      where: { tokenHash: this.hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(identity: AuthenticatedUser): Promise<Record<string, unknown>> {
    const user = await this.prisma.user.findUnique({
      where: { id: identity.userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        emailVerifiedAt: true,
        acceptedTermsVersion: true,
        acceptedPrivacyVersion: true,
        createdAt: true,
      },
    });
    if (!user) throw new UnauthorizedException('Account no longer exists');
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: identity.workspaceId },
      select: { id: true, name: true, slug: true, plan: true },
    });
    return { ...user, workspace };
  }

  async requestEmailVerification(identity: AuthenticatedUser): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: identity.userId } });
    if (!user || user.emailVerifiedAt) return;
    await this.sendEmailVerification(user.id, user.email, user.displayName);
  }

  async verifyEmail(token: string): Promise<void> {
    const tokenHash = this.hashToken(token);
    const record = await this.prisma.emailVerificationToken.findUnique({ where: { tokenHash } });
    if (!record || record.usedAt || record.expiresAt <= new Date()) {
      throw new UnauthorizedException('Token de verificação inválido ou expirado.');
    }
    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      this.prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } }),
      this.prisma.auditLog.create({
        data: { userId: record.userId, action: 'auth.email_verified', resource: 'user', resourceId: record.userId },
      }),
    ]);
  }

  async forgotPassword(input: ForgotPasswordDto): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user) return;
    const token = randomBytes(48).toString('base64url');
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await this.email?.send({
      to: user.email,
      subject: 'Redefina sua senha no ClipBR',
      text: `Acesse ${this.appUrl}/reset-password?token=${token} para redefinir sua senha. O link expira em 1 hora.`,
      html: `<p>Use o link abaixo para redefinir sua senha. Ele expira em 1 hora.</p><p><a href="${this.appUrl}/reset-password?token=${token}">Redefinir senha</a></p>`,
    });
  }

  async resetPassword(input: ResetPasswordDto): Promise<void> {
    const tokenHash = this.hashToken(input.token);
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!record || record.usedAt || record.expiresAt <= new Date()) {
      throw new UnauthorizedException('Token de redefinição inválido ou expirado.');
    }
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      this.prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
      this.prisma.refreshSession.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.prisma.auditLog.create({
        data: { userId: record.userId, action: 'auth.password_reset', resource: 'user', resourceId: record.userId },
      }),
    ]);
  }

  private async issueTokens(identity: AuthenticatedUser): Promise<AuthTokens> {
    const accessToken = await this.jwt.signAsync(
      { sub: identity.userId, wid: identity.workspaceId, email: identity.email, type: 'access' },
      { expiresIn: this.accessTtl as never },
    );
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.refreshSession.create({
      data: {
        userId: identity.userId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + this.refreshDays * 24 * 60 * 60 * 1000),
      },
    });
    return { accessToken, refreshToken, expiresInSeconds: 15 * 60 };
  }

  private hashToken(token: string): string {
    return createHmac('sha256', this.refreshSecret).update(token).digest('hex');
  }

  private async sendEmailVerification(userId: string, email: string, displayName: string): Promise<void> {
    const token = randomBytes(48).toString('base64url');
    await this.prisma.emailVerificationToken.create({
      data: {
        userId,
        tokenHash: this.hashToken(token),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    await this.email?.send({
      to: email,
      subject: 'Verifique seu e-mail no ClipBR',
      text: `Olá, ${displayName}. Acesse ${this.appUrl}/verify-email?token=${token} para verificar seu e-mail.`,
      html: `<p>Olá, ${displayName}.</p><p><a href="${this.appUrl}/verify-email?token=${token}">Verificar e-mail</a></p>`,
    });
  }
}
