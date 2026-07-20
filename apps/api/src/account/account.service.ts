import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly videos: VideoLifecycleService,
  ) {}

  async exportData(user: AuthenticatedUser): Promise<unknown> {
    const account = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        createdAt: true,
        memberships: {
          include: {
            workspace: {
              include: {
                projects: true,
                videos: {
                  include: { transcript: true, segments: { include: { viralScore: true } }, clips: { include: { seo: true } } },
                },
                subscriptions: true,
                usageEvents: true,
              },
            },
          },
        },
      },
    });
    return JSON.parse(JSON.stringify(account, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)));
  }

  async remove(user: AuthenticatedUser, password: string): Promise<void> {
    const account = await this.prisma.user.findUnique({
      where: { id: user.userId },
      include: { ownedWorkspaces: { select: { id: true } } },
    });
    if (!account || !(await argon2.verify(account.passwordHash, password))) {
      throw new UnauthorizedException('Password is invalid');
    }
    const workspaceIds = account.ownedWorkspaces.map((workspace) => workspace.id);
    const videoIds = await this.videos.prepareWorkspaceDeletion(workspaceIds);
    await this.prisma.$transaction(async (tx) => {
      await tx.outboxEvent.deleteMany({ where: { aggregateId: { in: videoIds } } });
      await tx.workspace.deleteMany({ where: { ownerId: user.userId } });
      await tx.user.delete({ where: { id: user.userId } });
    });
  }
}
