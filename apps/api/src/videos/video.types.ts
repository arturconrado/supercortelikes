import type { Readable } from 'node:stream';

export type VideoStatus = 'UPLOADING' | 'UPLOADED' | 'FAILED';

export interface VideoRecord {
  id: string;
  originalFilename: string;
  title?: string | null;
  storageKey: string;
  storageBucket: string;
  thumbnailKey?: string | null;
  mimeType: string;
  container: string;
  sizeBytes: bigint | null;
  checksumSha256: string | null;
  storageEtag: string | null;
  status: VideoStatus;
  failureCode: string | null;
  burnedInSubtitlesDetected?: boolean;
  burnedInSubtitlesConfidence?: number | null;
  durationMs?: bigint | null;
  processingOptions?: unknown | null;
  projectId?: string | null;
  sourceUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
  pipelineRuns?: Array<{ status: string; currentStage: string | null }>;
  _count?: { clips?: number };
}

export interface UploadFile {
  filename: string;
  mimetype: string;
  stream: Readable;
}

export interface CreateUploadInput {
  videoId: string;
  attemptId: string;
  idempotencyKey: string;
  originalFilename: string;
  title?: string;
  storageKey: string;
  storageBucket: string;
  mimeType: string;
  container: string;
  workspaceId?: string;
  ownerId?: string;
  projectId?: string;
}

export interface CompleteUploadInput {
  sizeBytes: bigint;
  checksumSha256?: string;
  storageEtag?: string;
}
