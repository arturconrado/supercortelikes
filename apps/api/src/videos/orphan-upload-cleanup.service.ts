import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/storage.port';

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const FALLBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 100;
const PENDING_CODE = 'UPLOAD_EXPIRED_STORAGE_PENDING';
const EXPIRED_CODE = 'UPLOAD_SESSION_EXPIRED';

@Injectable()
export class OrphanUploadCleanupService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OrphanUploadCleanupService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  onApplicationBootstrap(): void {
    void this.cleanupOnce();
    this.timer = setInterval(() => void this.cleanupOnce(), CLEANUP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async cleanupOnce(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const attempts = await this.prisma.uploadAttempt.findMany({
        where: {
          OR: [
            {
              status: 'STARTED',
              OR: [
                { expiresAt: { lte: now } },
                { expiresAt: null, startedAt: { lte: new Date(now.getTime() - FALLBACK_MAX_AGE_MS) } },
              ],
            },
            { status: 'FAILED', failureCode: PENDING_CODE },
          ],
        },
        include: { video: { select: { id: true, storageKey: true } } },
        orderBy: { startedAt: 'asc' },
        take: CLEANUP_BATCH_SIZE,
      });
      let cleaned = 0;
      for (const attempt of attempts) {
        if (attempt.status === 'STARTED') {
          const claimed = await this.prisma.$transaction(async (tx) => {
            const result = await tx.uploadAttempt.updateMany({
              where: { id: attempt.id, status: 'STARTED' },
              data: { status: 'FAILED', failureCode: PENDING_CODE, completedAt: now },
            });
            if (!result.count) return false;
            await tx.video.updateMany({
              where: { id: attempt.videoId, status: 'UPLOADING' },
              data: { status: 'FAILED', failureCode: EXPIRED_CODE, failureMessage: 'Direct upload session expired before completion' },
            });
            return true;
          });
          if (!claimed) continue;
        }
        try {
          if (attempt.providerUploadId) {
            await this.storage.abortMultipart(attempt.video.storageKey, attempt.providerUploadId);
          }
          await this.prisma.uploadAttempt.updateMany({
            where: { id: attempt.id, status: 'FAILED', failureCode: PENDING_CODE },
            data: { failureCode: EXPIRED_CODE },
          });
          cleaned += 1;
        } catch (error) {
          if (isMissingMultipart(error)) {
            await this.prisma.uploadAttempt.updateMany({
              where: { id: attempt.id, status: 'FAILED', failureCode: PENDING_CODE },
              data: { failureCode: EXPIRED_CODE },
            });
            cleaned += 1;
          } else {
            this.logger.warn({ attemptId: attempt.id, videoId: attempt.videoId, error: safeError(error) }, 'Could not abort expired multipart upload; it will be retried');
          }
        }
      }
      if (cleaned) this.logger.log({ cleaned }, 'Expired multipart uploads cleaned');
      return cleaned;
    } finally {
      this.running = false;
    }
  }
}

function isMissingMultipart(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  return value.name === 'NoSuchUpload' || value.Code === 'NoSuchUpload' || value.code === 'NoSuchUpload' || value.$metadata?.httpStatusCode === 404;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}
