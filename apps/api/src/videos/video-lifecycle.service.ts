import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { MediaWorkerClient } from '../media/media-worker.client';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/storage.port';

type LifecycleVideo = {
  id: string;
  storageKey: string;
  thumbnailKey: string | null;
  uploads: Array<{ status: string; providerUploadId: string | null }>;
  pipelineRuns: Array<{ id: string }>;
  clips: Array<{
    thumbnailKey: string | null;
    exports: Array<{ storageKey: string | null }>;
    captions: Array<{ srtKey: string | null; assKey: string | null }>;
  }>;
};

const lifecycleInclude = {
  uploads: { select: { status: true, providerUploadId: true } },
  pipelineRuns: { select: { id: true } },
  clips: {
    select: {
      thumbnailKey: true,
      exports: { select: { storageKey: true } },
      captions: { select: { srtKey: true, assKey: true } },
    },
  },
} as const;

@Injectable()
export class VideoLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly media: MediaWorkerClient,
  ) {}

  async remove(videoId: string, workspaceId: string): Promise<void> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, workspaceId },
      include: lifecycleInclude,
    });
    if (!video) throw new NotFoundException('Video not found');
    await this.cleanupArtifacts([video]);
    await this.prisma.$transaction([
      this.prisma.outboxEvent.deleteMany({ where: { aggregateId: video.id } }),
      this.prisma.video.delete({ where: { id: video.id } }),
    ]);
  }

  async prepareWorkspaceDeletion(workspaceIds: string[]): Promise<string[]> {
    if (!workspaceIds.length) return [];
    const videos = await this.prisma.video.findMany({
      where: { workspaceId: { in: workspaceIds } },
      include: lifecycleInclude,
    });
    await this.cleanupArtifacts(videos);
    return videos.map((video) => video.id);
  }

  private async cleanupArtifacts(videos: LifecycleVideo[]): Promise<void> {
    for (const video of videos) {
      await Promise.all(video.uploads
        .filter((attempt) => attempt.status === 'STARTED' && attempt.providerUploadId)
        .map((attempt) => this.storage.abortMultipart(video.storageKey, attempt.providerUploadId!).catch(() => undefined)));
    }

    const storageKeys = new Set<string>();
    const storagePrefixes = new Set<string>();
    const pipelineRunIds = new Set<string>();
    for (const video of videos) {
      storageKeys.add(video.storageKey);
      storagePrefixes.add(`videos/${video.id}/`);
      storagePrefixes.add(`imports/${video.id}/`);
      storagePrefixes.add(`thumbnails/videos/${video.id}/`);
      storagePrefixes.add(`exports/${video.id}/`);
      if (video.thumbnailKey) storageKeys.add(video.thumbnailKey);
      for (const run of video.pipelineRuns) pipelineRunIds.add(run.id);
      for (const clip of video.clips) {
        if (clip.thumbnailKey) storageKeys.add(clip.thumbnailKey);
        for (const item of clip.exports) if (item.storageKey) storageKeys.add(item.storageKey);
        for (const caption of clip.captions) {
          if (isStorageKey(caption.srtKey)) storageKeys.add(caption.srtKey);
          if (isStorageKey(caption.assKey)) storageKeys.add(caption.assKey);
        }
      }
    }
    await Promise.all([
      ...[...storageKeys].map((key) => this.storage.delete(key)),
      ...[...storagePrefixes].map((prefix) => this.storage.deletePrefix(prefix)),
    ]);
    await this.media.cleanupWorkspaces([...pipelineRunIds]);
  }
}

function isStorageKey(value: string | null): value is string {
  return Boolean(value) && !value!.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value!);
}
