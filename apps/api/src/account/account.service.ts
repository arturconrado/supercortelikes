import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/storage.port';

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
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
      include: { ownedWorkspaces: { select: { id: true, videos: { select: { storageKey: true } } } } },
    });
    if (!account || !(await argon2.verify(account.passwordHash, password))) {
      throw new UnauthorizedException('Password is invalid');
    }
    for (const workspace of account.ownedWorkspaces) {
      for (const video of workspace.videos) await this.storage.delete(video.storageKey);
    }
    await this.prisma.$transaction(async (tx) => {
      const videoIds = await tx.video.findMany({
        where: { workspaceId: { in: account.ownedWorkspaces.map((workspace) => workspace.id) } },
        select: { id: true },
      });
      await tx.outboxEvent.deleteMany({ where: { aggregateId: { in: videoIds.map((video) => video.id) } } });
      await tx.workspace.deleteMany({ where: { ownerId: user.userId } });
      await tx.user.delete({ where: { id: user.userId } });
    });
  }
}
