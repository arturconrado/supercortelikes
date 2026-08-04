import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';
import { UsageService } from '../usage/usage.service';

@Injectable()
export class ProjectProcessingService {
  constructor(private readonly prisma: PrismaService, private readonly usage: UsageService) {}

  async reprocess(projectId: string, user: AuthenticatedUser): Promise<{ pipelineRunIds: string[]; videosQueued: number }> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId: user.workspaceId },
      include: {
        videos: {
          select: {
            id: true,
            status: true,
            storageKey: true,
            workspaceId: true,
            projectId: true,
            durationMs: true,
            _count: { select: { clips: true } },
            pipelineRuns: {
              where: { status: { in: ['PENDING', 'RUNNING'] } },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    if (!project.videos.length) throw new BadRequestException('Adicione um vídeo ao projeto antes de reprocessar.');
    if (project.videos.some((video) => video.status !== 'UPLOADED')) {
      throw new ConflictException('Todos os vídeos precisam ter um upload concluído antes do reprocessamento.');
    }
    if (project.videos.some((video) => video._count.clips > 0)) {
      throw new ConflictException('Este projeto já possui cortes. Para preservar edições e exports, envie o vídeo novamente em vez de substituir os resultados existentes.');
    }
    if (project.videos.some((video) => video.pipelineRuns.length > 0)) {
      throw new ConflictException('Este projeto já possui um processamento ativo.');
    }
    await this.usage.assertCanProcessVideos(project.videos.map((video) => video.id), user);

    const runs = project.videos.map((video) => ({
      video,
      eventId: randomUUID(),
      pipelineRunId: randomUUID(),
      stageExecutionId: randomUUID(),
      occurredAt: new Date(),
    }));
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0))`;
      const activeRuns = await tx.pipelineRun.count({
        where: {
          videoId: { in: runs.map((run) => run.video.id) },
          status: { in: ['PENDING', 'RUNNING'] },
        },
      });
      if (activeRuns > 0) throw new ConflictException('Este projeto já possui um processamento ativo.');
      for (const run of runs) {
        await tx.video.update({
          where: { id: run.video.id },
          data: { status: 'UPLOADED', failureCode: null, failureMessage: null },
        });
        await tx.outboxEvent.create({
          data: {
            id: run.eventId,
            aggregateId: run.video.id,
            type: 'video.uploaded.v2',
            payload: {
              schemaVersion: 2,
              eventId: run.eventId,
              pipelineRunId: run.pipelineRunId,
              stageExecutionId: run.stageExecutionId,
              videoId: run.video.id,
              tenantId: run.video.workspaceId,
              projectId: run.video.projectId,
              sourceObjectKey: run.video.storageKey,
              stage: 'ingestion',
              correlationId: run.pipelineRunId,
              causationId: run.eventId,
              occurredAt: run.occurredAt.toISOString(),
              reprocessed: true,
            },
          },
        });
        await tx.pipelineRun.create({
          data: {
            id: run.pipelineRunId,
            videoId: run.video.id,
            sourceEventId: run.eventId,
            currentStage: 'INGESTION',
          },
        });
        await tx.stageExecution.create({
          data: {
            id: run.stageExecutionId,
            pipelineRunId: run.pipelineRunId,
            stage: 'INGESTION',
            jobId: run.eventId,
          },
        });
      }
      await tx.auditLog.create({
        data: {
          userId: user.userId,
          workspaceId: user.workspaceId,
          action: 'project.reprocess',
          resource: 'project',
          resourceId: projectId,
          metadata: { pipelineRunIds: runs.map((run) => run.pipelineRunId), videosQueued: runs.length },
        },
      });
    });
    return { pipelineRunIds: runs.map((run) => run.pipelineRunId), videosQueued: runs.length };
  }
}
