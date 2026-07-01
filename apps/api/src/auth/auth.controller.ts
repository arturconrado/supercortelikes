import { Body, Controller, Get, HttpCode, HttpStatus, Optional, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CurrentUser, Public } from './auth.decorators';
import { ForgotPasswordDto, LoginDto, RefreshDto, RegisterDto, RequestEmailVerificationDto, ResetPasswordDto, VerifyEmailDto } from './auth.dto';
import { AbuseProtectionService } from './abuse-protection.service';
import { AuthService } from './auth.service';
import type { AuthenticatedUser } from './auth.types';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Optional() private readonly abuse?: AbuseProtectionService,
  ) {}

  @Public()
  @Post('register')
  async register(@Body() input: RegisterDto, @Req() request?: FastifyRequest): Promise<Record<string, unknown>> {
    await this.abuse?.verify(input.turnstileToken, request?.ip);
    const result = await this.auth.register(input);
    return {
      user: { id: result.user.userId, name: result.user.displayName, email: result.user.email },
      ...result.tokens,
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
  async login(@Body() input: LoginDto): Promise<Record<string, unknown>> {
    const result = await this.auth.login(input);
    return {
      user: { id: result.user.userId, name: result.user.displayName, email: result.user.email },
      ...result.tokens,
    };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(@Body() input: RefreshDto): Promise<Record<string, unknown>> {
    return { tokens: await this.auth.refresh(input.refreshToken) };
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  async logout(@Body() input: RefreshDto): Promise<void> {
    await this.auth.logout(input.refreshToken);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser): Promise<Record<string, unknown>> {
    return this.auth.me(user);
  }
}
