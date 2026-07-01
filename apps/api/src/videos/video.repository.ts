import type { CompleteUploadInput, CreateUploadInput, VideoRecord } from './video.types';

export const VIDEO_REPOSITORY = Symbol('VIDEO_REPOSITORY');

export interface UploadWithVideo {
  id: string;
  video: VideoRecord;
}

export interface VideoRepository {
  findByIdempotencyKey(key: string): Promise<UploadWithVideo | null>;
  findById(id: string, workspaceId?: string): Promise<VideoRecord | null>;
  updateTitle(id: string, workspaceId: string, title: string): Promise<VideoRecord | null>;
  createUpload(input: CreateUploadInput): Promise<VideoRecord>;
  markUploaded(videoId: string, attemptId: string, input: CompleteUploadInput): Promise<VideoRecord>;
  markFailed(videoId: string, attemptId: string, code: string, message: string, bytesReceived: bigint): Promise<void>;
}
