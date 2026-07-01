import { Controller, Get, Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/storage.port';

@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Get(['summary', 'overview'])
  async summary(@CurrentUser() user: AuthenticatedUser): Promise<Record<string, unknown>> {
    const workspaceId = user.workspaceId;
    const [videos, clips, exportsReady, usage, pipelines, downloads, recentVideos, recentProjects] = await Promise.all([
      this.prisma.video.count({ where: { workspaceId } }),
      this.prisma.clip.count({ where: { video: { workspaceId } } }),
      this.prisma.export.count({ where: { status: 'READY', clip: { video: { workspaceId } } } }),
      this.prisma.usageEvent.aggregate({
        where: { workspaceId },
        _sum: { quantity: true, costCents: true },
      }),
      this.prisma.pipelineRun.groupBy({
        by: ['status'],
        where: { video: { workspaceId } },
        _count: { _all: true },
      }),
      this.prisma.usageEvent.count({ where: { workspaceId, type: 'export.downloaded' } }),
      this.prisma.video.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 6,
        include: {
          _count: { select: { clips: true } },
          pipelineRuns: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, currentStage: true } },
        },
      }),
      this.prisma.project.findMany({
        where: { workspaceId },
        orderBy: { updatedAt: 'desc' },
        take: 3,
        include: {
          _count: { select: { videos: true } },
          videos: {
            take: 1,
            orderBy: { createdAt: 'desc' },
            include: {
              _count: { select: { clips: true } },
              pipelineRuns: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
            },
          },
        },
      }),
    ]);
    return {
      videos,
      clips,
      exportsReady,
      downloads,
      videosProcessed: videos,
      clipsGenerated: clips,
      processingMinutes: usage._sum.quantity?.toString() ?? '0',
      creditsUsed: usage._sum.costCents ?? 0,
      usageQuantity: usage._sum.quantity?.toString() ?? '0',
      costCents: usage._sum.costCents ?? 0,
      pipelines: Object.fromEntries(pipelines.map((item) => [item.status.toLowerCase(), item._count._all])),
      recentVideos: await Promise.all(recentVideos.map(async (video) => ({
        ...video,
        sizeBytes: video.sizeBytes?.toString() ?? null,
        durationSeconds: video.durationMs ? Number(video.durationMs) / 1000 : undefined,
        clipsCount: video._count.clips,
        processingStatus: video.pipelineRuns[0]?.status ?? (video.status === 'UPLOADED' ? 'PENDING' : video.status),
        currentStage: video.pipelineRuns[0]?.currentStage ?? null,
        thumbnailUrl: video.thumbnailKey ? await this.storage.downloadUrl(video.thumbnailKey, 900) : undefined,
      }))),
      recentProjects: recentProjects.map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        videosCount: project._count.videos,
        clipsCount: project.videos.reduce((sum, video) => sum + video._count.clips, 0),
        status: project.videos.some((video) => video.status === 'FAILED')
          ? 'FAILED'
          : project.videos.some((video) => video.pipelineRuns?.some((run) => run.status === 'RUNNING' || run.status === 'PENDING'))
            ? 'PROCESSING'
            : 'READY',
      })),
    };
  }

  @Get()
  async overview(@CurrentUser() user: AuthenticatedUser): Promise<Record<string, unknown>> {
    const [summary, activity] = await Promise.all([this.summary(user), this.timeseries(user)]);
    return { ...summary, activity };
  }

  @Get('timeseries')
  async timeseries(@CurrentUser() user: AuthenticatedUser): Promise<unknown> {
    const rows = await this.prisma.$queryRaw<Array<{ day: Date; events: bigint; costCents: bigint }>>(Prisma.sql`
      SELECT date_trunc('day', "createdAt") AS day,
             COUNT(*)::bigint AS events,
             COALESCE(SUM("costCents"), 0)::bigint AS "costCents"
      FROM "usage_events"
      WHERE "workspaceId" = ${user.workspaceId}::uuid
        AND "createdAt" >= NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1 ASC
    `);
    return rows.map((row) => ({
      day: row.day.toISOString().slice(0, 10),
      events: row.events.toString(),
      costCents: row.costCents.toString(),
    }));
  }
}
