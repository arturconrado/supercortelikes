import type { VideoRecord } from './video.types';
import { normalizeVideoProcessingOptions, type VideoProcessingOptions } from './video-processing-options';

export class VideoResponseDto {
  id!: string;
  status!: string;
  originalFilename!: string;
  title?: string | null;
  mimeType!: string;
  container!: string;
  sizeBytes!: string | null;
  checksumSha256!: string | null;
  storageEtag!: string | null;
  failureCode!: string | null;
  durationSeconds?: number;
  projectId?: string | null;
  playbackUrl?: string;
  thumbnailUrl?: string;
  burnedInSubtitlesDetected?: boolean;
  burnedInSubtitlesConfidence?: number | null;
  processingStatus?: string;
  currentStage?: string | null;
  clipsCount?: number;
  processingOptions?: VideoProcessingOptions;
  createdAt!: string;
  updatedAt!: string;
  reused?: boolean;

  static from(record: VideoRecord, reused = false): VideoResponseDto {
    const latestRun = record.pipelineRuns?.[0];
    return {
      id: record.id,
      status: record.status,
      originalFilename: record.originalFilename,
      title: record.title ?? record.originalFilename,
      mimeType: record.mimeType,
      container: record.container,
      sizeBytes: record.sizeBytes?.toString() ?? null,
      checksumSha256: record.checksumSha256,
      storageEtag: record.storageEtag,
      failureCode: record.failureCode,
      burnedInSubtitlesDetected: record.burnedInSubtitlesDetected,
      burnedInSubtitlesConfidence: record.burnedInSubtitlesConfidence,
      durationSeconds: record.durationMs ? Number(record.durationMs) / 1000 : undefined,
      projectId: record.projectId,
      processingStatus: latestRun?.status ?? (record.status === 'FAILED' ? 'FAILED' : record.status === 'UPLOADED' ? 'PENDING' : record.status),
      currentStage: latestRun?.currentStage ?? null,
      clipsCount: record._count?.clips,
      processingOptions: normalizeVideoProcessingOptions(record.processingOptions as never),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      ...(reused ? { reused: true } : {}),
    };
  }
}
