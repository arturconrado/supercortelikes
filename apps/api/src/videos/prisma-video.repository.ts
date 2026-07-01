import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import type { CompleteUploadInput, CreateUploadInput, VideoRecord } from './video.types';
import type { UploadWithVideo, VideoRepository } from './video.repository';

@Injectable()
export class PrismaVideoRepository implements VideoRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByIdempotencyKey(key: string): Promise<UploadWithVideo | null> {
    const upload = await this.prisma.uploadAttempt.findUnique({
      where: { idempotencyKey: key },
      include: { video: true },
    });
    return upload ? { id: upload.id, video: upload.video as VideoRecord } : null;
  }

  async findById(id: string, workspaceId?: string): Promise<VideoRecord | null> {
    return this.prisma.video.findFirst({
      where: { id, ...(workspaceId ? { workspaceId } : {}) },
      include: {
        _count: { select: { clips: true } },
        pipelineRuns: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, currentStage: true } },
      },
    }) as Promise<VideoRecord | null>;
  }

  async updateTitle(id: string, workspaceId: string, title: string): Promise<VideoRecord | null> {
    const video = await this.prisma.video.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!video) return null;
    return this.prisma.video.update({
      where: { id },
      data: { title },
      include: {
        _count: { select: { clips: true } },
        pipelineRuns: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, currentStage: true } },
      },
    }) as Promise<VideoRecord | null>;
  }

  async createUpload(input: CreateUploadInput): Promise<VideoRecord> {
    return this.prisma.$transaction(async (tx) => {
      const video = await tx.video.create({
        data: {
          id: input.videoId,
          originalFilename: input.originalFilename,
          title: input.title ?? input.originalFilename,
          storageKey: input.storageKey,
          storageBucket: input.storageBucket,
          mimeType: input.mimeType,
          container: input.container,
          workspaceId: input.workspaceId,
          ownerId: input.ownerId,
          projectId: input.projectId,
        },
      });
      await tx.uploadAttempt.create({
        data: {
          id: input.attemptId,
          videoId: input.videoId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      return video as VideoRecord;
    });
  }

  async markUploaded(videoId: string, attemptId: string, input: CompleteUploadInput): Promise<VideoRecord> {
    return this.prisma.$transaction(async (tx) => {
      const eventId = randomUUID();
      const pipelineRunId = randomUUID();
      const stageExecutionId = randomUUID();
      const occurredAt = new Date();
      const video = await tx.video.update({
        where: { id: videoId, status: 'UPLOADING' },
        data: {
          status: 'UPLOADED',
          sizeBytes: input.sizeBytes,
          checksumSha256: input.checksumSha256,
          storageEtag: input.storageEtag,
        },
      });
      await tx.uploadAttempt.update({
        where: { id: attemptId },
        data: {
          status: 'COMPLETED',
          bytesReceived: input.sizeBytes,
          completedAt: new Date(),
        },
      });
      await tx.outboxEvent.create({
        data: {
          id: eventId,
          aggregateId: videoId,
          type: 'video.uploaded.v2',
          payload: {
            schemaVersion: 2,
            eventId,
            pipelineRunId,
            stageExecutionId,
            videoId,
            tenantId: video.workspaceId,
            projectId: video.projectId,
            sourceObjectKey: video.storageKey,
            stage: 'ingestion',
            correlationId: pipelineRunId,
            causationId: eventId,
            occurredAt: occurredAt.toISOString(),
          },
        },
      });
      await tx.pipelineRun.create({
        data: {
          id: pipelineRunId,
          videoId,
          sourceEventId: eventId,
          currentStage: 'INGESTION',
        },
      });
      await tx.stageExecution.create({
        data: {
          id: stageExecutionId,
          pipelineRunId,
          stage: 'INGESTION',
          jobId: eventId,
        },
      });
      return video as VideoRecord;
    });
  }

  async markFailed(
    videoId: string,
    attemptId: string,
    code: string,
    message: string,
    bytesReceived: bigint,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.video.update({
        where: { id: videoId },
        data: { status: 'FAILED', failureCode: code, failureMessage: message },
      }),
      this.prisma.uploadAttempt.update({
        where: { id: attemptId },
        data: { status: 'FAILED', failureCode: code, bytesReceived, completedAt: new Date() },
      }),
    ]);
  }
}
