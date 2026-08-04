import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { IS_PUBLIC_KEY } from './auth.decorators';
import type { AuthenticatedUser } from './auth.types';
import { PrismaService } from '../database/prisma.service';

interface AccessPayload {
  sub: string;
  wid: string;
  email: string;
  type: 'access';
  sid: string;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Bearer access token is required');
    try {
      const payload = await this.jwt.verifyAsync<AccessPayload>(token);
      if (payload.type !== 'access' || !payload.sub || !payload.wid || !payload.sid) throw new Error('Invalid token claims');
      const session = await this.prisma.refreshSession.findUnique({
        where: { id: payload.sid },
        select: { userId: true, revokedAt: true, expiresAt: true },
      });
      if (!session || session.userId !== payload.sub || session.revokedAt || session.expiresAt <= new Date()) {
        throw new Error('Access session is no longer active');
      }
      request.user = { userId: payload.sub, workspaceId: payload.wid, email: payload.email };
      return true;
    } catch {
      throw new UnauthorizedException('Access token is invalid or expired');
    }
  }
}
