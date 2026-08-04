import { Body, Controller, Get, HttpCode, HttpStatus, Optional, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Environment } from '../config/env';
import { CurrentUser, Public } from './auth.decorators';
import { ForgotPasswordDto, LoginDto, RefreshDto, RegisterDto, RequestEmailVerificationDto, ResetPasswordDto, VerifyEmailDto } from './auth.dto';
import { AbuseProtectionService } from './abuse-protection.service';
import { AuthService } from './auth.service';
import type { AuthenticatedUser } from './auth.types';

@Controller('auth')
export class AuthController {
  private readonly cookieName: string;
  private readonly cookieSecure: boolean;
  private readonly refreshMaxAgeSeconds: number;

  constructor(
    private readonly auth: AuthService,
    config: ConfigService<Environment, true>,
    @Optional() private readonly abuse?: AbuseProtectionService,
  ) {
    this.cookieSecure = config.get('NODE_ENV', { infer: true }) === 'production';
    this.cookieName = this.cookieSecure ? '__Host-picashorts.refresh' : 'picashorts.refresh';
    this.refreshMaxAgeSeconds = config.get('JWT_REFRESH_DAYS', { infer: true }) * 24 * 60 * 60;
  }

  @Public()
  @Post('register')
  async register(
    @Body() input: RegisterDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    await this.abuse?.verify(input.turnstileToken, request?.ip);
    const result = await this.auth.register(input);
    this.setRefreshCookie(reply, result.tokens.refreshToken);
    return {
      user: { id: result.user.userId, name: result.user.displayName, email: result.user.email },
      ...this.clientTokens(request, result.tokens),
    };
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('email/verify')
  async verifyEmail(@Body() input: VerifyEmailDto): Promise<void> {
    await this.auth.verifyEmail(input.token);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('email/verification')
  async requestEmailVerification(@CurrentUser() user: AuthenticatedUser, @Body() _input: RequestEmailVerificationDto): Promise<void> {
    await this.auth.requestEmailVerification(user);
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('password/forgot')
  async forgotPassword(@Body() input: ForgotPasswordDto, @Req() request?: FastifyRequest): Promise<void> {
    await this.abuse?.verify(input.turnstileToken, request?.ip);
    await this.auth.forgotPassword(input);
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('password/reset')
  async resetPassword(@Body() input: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(input);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @Body() input: LoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const result = await this.auth.login(input);
    this.setRefreshCookie(reply, result.tokens.refreshToken);
    return {
      user: { id: result.user.userId, name: result.user.displayName, email: result.user.email },
      ...this.clientTokens(request, result.tokens),
    };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(
    @Body() input: RefreshDto | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Record<string, unknown>> {
    const tokens = await this.auth.refresh(this.refreshToken(request, input));
    this.setRefreshCookie(reply, tokens.refreshToken);
    return { tokens: this.clientTokens(request, tokens) };
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  async logout(
    @Body() input: RefreshDto | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const token = this.refreshToken(request, input, false);
    if (token) await this.auth.logout(token);
    this.clearRefreshCookie(reply);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.auth.me(user);
  }

  private refreshToken(request: FastifyRequest, input?: RefreshDto, required = true): string {
    const token = input?.refreshToken ?? cookieValue(request.headers.cookie, this.cookieName);
    if (!token && required) throw new UnauthorizedException('Refresh token is unavailable');
    return token ?? '';
  }

  private clientTokens(request: FastifyRequest, tokens: { accessToken: string; refreshToken: string; expiresInSeconds: number }): Record<string, unknown> {
    const webClient = request.headers['x-requested-with'] === 'picashorts-web';
    return {
      accessToken: tokens.accessToken,
      expiresInSeconds: tokens.expiresInSeconds,
      ...(!webClient ? { refreshToken: tokens.refreshToken } : {}),
    };
  }

  private setRefreshCookie(reply: FastifyReply, token: string): void {
    reply.header('Set-Cookie', serializeCookie(this.cookieName, token, {
      maxAge: this.refreshMaxAgeSeconds,
      secure: this.cookieSecure,
    }));
  }

  private clearRefreshCookie(reply: FastifyReply): void {
    reply.header('Set-Cookie', serializeCookie(this.cookieName, '', { maxAge: 0, secure: this.cookieSecure }));
  }
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) return decodeURIComponent(rawValue.join('='));
  }
  return undefined;
}

function serializeCookie(name: string, value: string, options: { maxAge: number; secure: boolean }): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAge}`,
    ...(options.secure ? ['Secure'] : []),
  ].join('; ');
}
