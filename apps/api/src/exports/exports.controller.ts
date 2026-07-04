import { randomUUID } from 'node:crypto';
import { Body, ConflictException, Controller, Delete, Get, HttpCode, HttpStatus, Inject, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/storage.port';
import { DeadLetterService } from '../queues/dead-letter.service';
import { CreateExportDto } from './exports.dto';

@Controller('exports')
export class ExportsController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly deadLetters: DeadLetterService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<unknown> {
    const exports = await this.prisma.export.findMany({
      where: { clip: { video: { workspaceId: user.workspaceId } } },
      orderBy: { createdAt: 'desc' },
      include: { clip: { select: { title: true } } },
    });
    return exports.map((item) => ({
      ...item,
      clipTitle: item.clip.title,
      sizeBytes: item.sizeBytes?.toString() ?? null,
      downloadUrl: item.status === 'READY' ? `/exports/${item.id}/download` : undefined,
    }));
  }

  @Post()
  async create(@CurrentUser() user: AuthenticatedUser, @Body() input: CreateExportDto): Promise<unknown> {
    const clip = await this.prisma.clip.findFirst({
      where: { id: input.clipId, video: { workspaceId: user.workspaceId } },
      include: { exports: true },
    });
    if (!clip) throw new NotFoundException('Clip not found');
    const existing = clip.exports.find(
      (item) => item.format === input.format && item.aspectRatio === input.aspectRatio && ['READY', 'QUEUED', 'PROCESSING'].includes(item.status),
    );
    if (existing) return { ...existing, sizeBytes: existing.sizeBytes?.toString() ?? null };
    const created = await this.prisma.export.create({
      data: { clipId: clip.id, format: input.format, aspectRatio: input.aspectRatio, status: 'QUEUED' },
    });
    await this.prisma.clip.update({ where: { id: clip.id }, data: { status: 'RENDERING' } });
    await this.queueRenderingRun(clip.videoId);
    return { ...created, sizeBytes: null };
  }

  @Get(':id/download')
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const item = await this.prisma.export.findFirst({
      where: { id, status: 'READY', clip: { video: { workspaceId: user.workspaceId } } },
      include: { clip: { include: { video: true } } },
    });
    if (!item?.storageKey) throw new NotFoundException('Ready export not found');
    await this.prisma.usageEvent.create({
      data: {
        workspaceId: user.workspaceId,
        videoId: item.clip.videoId,
        type: 'export.downloaded',
        quantity: 1,
        unit: 'download',
        metadata: { exportId: item.id },
      },
    });
    return {
      url: await this.storage.downloadUrl(item.storageKey, 900, {
        disposition: 'attachment',
        filename: exportFilename(item.clip.title),
        contentType: 'video/mp4',
      }),
      expiresInSeconds: 900,
    };
  }

  @Post(':id/retry')
  async retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ eventId: string }> {
    const item = await this.prisma.export.findFirst({
      where: { id, clip: { video: { workspaceId: user.workspaceId } } },
      include: { clip: true },
    });
    if (!item) throw new NotFoundException('Export not found');
    const deadLetter = await this.prisma.deadLetterJob.findFirst({
      where: {
        originalQueue: 'exports',
        status: 'OPEN',
        pipelineRun: { videoId: item.clip.videoId },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!deadLetter) throw new ConflictException('No failed export stage is available to retry');
    await this.prisma.export.update({ where: { id }, data: { status: 'QUEUED', errorCode: null } });
    return { eventId: await this.deadLetters.redrive(deadLetter.id) };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    const item = await this.prisma.export.findFirst({ where: { id, clip: { video: { workspaceId: user.workspaceId } } } });
    if (!item) throw new NotFoundException('Export not found');
    if (item.storageKey) await this.storage.delete(item.storageKey);
    await this.prisma.export.delete({ where: { id } });
  }

  private async queueRenderingRun(videoId: string): Promise<void> {
    const active = await this.prisma.pipelineRun.findFirst({
      where: { videoId, status: { in: ['PENDING', 'RUNNING'] }, currentStage: { in: ['RENDERING', 'EXPORTS'] } },
    });
    if (active) return;
    const eventId = randomUUID();
    const pipelineRunId = randomUUID();
    const stageExecutionId = randomUUID();
    const occurredAt = new Date();
    const job = {
      schemaVersion: 1,
      eventId,
      pipelineRunId,
      stageExecutionId,
      videoId,
      stage: 'rendering',
      correlationId: pipelineRunId,
      causationId: eventId,
      occurredAt: occurredAt.toISOString(),
    };
    await this.prisma.$transaction([
      this.prisma.pipelineRun.create({
        data: { id: pipelineRunId, videoId, sourceEventId: eventId, status: 'PENDING', currentStage: 'RENDERING' },
      }),
      this.prisma.stageExecution.create({
        data: { id: stageExecutionId, pipelineRunId, stage: 'RENDERING', jobId: eventId },
      }),
      this.prisma.outboxEvent.create({
        data: {
          id: eventId,
          aggregateId: videoId,
          type: 'pipeline.captions.completed.v1',
          payload: job as unknown as Prisma.InputJsonObject,
        },
      }),
    ]);
  }
}

function exportFilename(title?: string | null): string {
  const base = typeof title === 'string' && title.trim() ? title.trim() : 'picashorts-export';
  return /\.mp4$/i.test(base) ? base : `${base}.mp4`;
}
