import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { Environment } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { VideoResponseDto } from './video-response.dto';
import type { VideoRecord } from './video.types';
import { normalizeVideoProcessingOptions, type VideoProcessingOptionsInput } from './video-processing-options';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const YTDLP_PROVIDER_HOSTS = new Set(['loom.com', 'www.loom.com', 'drive.google.com']);
const DIRECT_VIDEO_SUFFIXES = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']);
type ImportSource = { originalFilename: string; title: string; mimeType: string; container: string };

@Injectable()
export class VideoImportService {
  private readonly bucket: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Environment, true>,
  ) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
  }

  async import(
    urlValue: string,
    idempotencyKey: string,
    user: AuthenticatedUser,
    projectId?: string,
    processingOptionsInput?: VideoProcessingOptionsInput,
  ): Promise<VideoResponseDto> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must contain 8-128 safe ASCII characters');
    }
    const previous = await this.prisma.uploadAttempt.findUnique({ where: { idempotencyKey }, include: { video: true } });
    if (previous) return VideoResponseDto.from(previous.video as VideoRecord, true);
    const url = parsePublicImportUrl(urlValue);
    const source = await resolveImportSource(url);
    if (projectId) {
      const project = await this.prisma.project.findFirst({ where: { id: projectId, workspaceId: user.workspaceId } });
      if (!project) throw new NotFoundException('Project not found');
    }
    const videoId = randomUUID();
    const attemptId = randomUUID();
    const eventId = randomUUID();
    const pipelineRunId = randomUUID();
    const stageExecutionId = randomUUID();
    const occurredAt = new Date();
    const processingOptions = normalizeVideoProcessingOptions(processingOptionsInput);
    try {
      const video = await this.prisma.$transaction(async (tx) => {
        const created = await tx.video.create({
          data: {
            id: videoId,
            originalFilename: source.originalFilename,
            title: source.title,
            storageKey: `imports/${videoId}/source.${source.container}`,
            sourceUrl: url.toString(),
            storageBucket: this.bucket,
            mimeType: source.mimeType,
            container: source.container,
            status: 'UPLOADED',
            workspaceId: user.workspaceId,
            ownerId: user.userId,
            projectId,
            processingOptions: processingOptions as Prisma.InputJsonObject,
          },
        });
        await tx.uploadAttempt.create({
          data: {
            id: attemptId,
            videoId,
            idempotencyKey,
            status: 'COMPLETED',
            completedAt: occurredAt,
          },
        });
        const job = {
          schemaVersion: 1,
          eventId,
          pipelineRunId,
          stageExecutionId,
          videoId,
          stage: 'ingestion',
          correlationId: pipelineRunId,
          causationId: eventId,
          occurredAt: occurredAt.toISOString(),
        };
        await tx.outboxEvent.create({ data: { id: eventId, aggregateId: videoId, type: 'video.uploaded.v1', payload: job } });
        await tx.pipelineRun.create({
          data: { id: pipelineRunId, videoId, sourceEventId: eventId, currentStage: 'INGESTION' },
        });
        await tx.stageExecution.create({
          data: { id: stageExecutionId, pipelineRunId, stage: 'INGESTION', jobId: eventId },
        });
        return created;
      });
      return VideoResponseDto.from(video as VideoRecord);
    } catch (error) {
      if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') {
        throw new ConflictException('An import with this idempotency key already exists');
      }
      throw error;
    }
  }
}

function parsePublicImportUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('Import URL is invalid');
  }
  if (url.protocol !== 'https:') throw new BadRequestException('Only public HTTPS URLs are accepted');
  const hostname = url.hostname.toLowerCase();
  if (isPrivateHostname(hostname)) throw new BadRequestException('Private or local URLs are not accepted');
  return url;
}

async function resolveImportSource(url: URL): Promise<ImportSource> {
  const hostname = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(hostname)) {
    const videoId = youtubeId(url);
    if (!videoId || !/^[A-Za-z0-9_-]{6,32}$/.test(videoId)) throw new BadRequestException('YouTube video id is invalid');
    const title = await youtubeOembedTitle(url);
    return { originalFilename: `youtube-${videoId}.mp4`, title: title ?? `YouTube ${videoId}`, mimeType: 'video/mp4', container: 'mp4' };
  }
  if (YTDLP_PROVIDER_HOSTS.has(hostname)) {
    const provider = hostname.includes('loom') ? 'loom' : 'google-drive';
    const sourceId = provider === 'loom' ? loomId(url) : googleDriveId(url);
    if (!sourceId) throw new BadRequestException(`${provider} import URL is invalid`);
    return { originalFilename: `${provider}-${sourceId}.mp4`, title: `${providerTitle(provider)} ${sourceId}`, mimeType: 'video/mp4', container: 'mp4' };
  }
  const suffix = directVideoSuffix(url);
  if (!suffix) {
    const title = safeImportFilename(hostname);
    return { originalFilename: `remote-${title}.mp4`, title, mimeType: 'video/mp4', container: 'mp4' };
  }
  const filename = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? `import${suffix}`);
  const container = suffix.slice(1) === 'm4v' ? 'mp4' : suffix.slice(1);
  const originalFilename = safeImportFilename(filename);
  return { originalFilename, title: displayTitleFromFilename(originalFilename), mimeType: mimeTypeForContainer(container), container };
}

async function youtubeOembedTitle(url: URL): Promise<string | undefined> {
  const endpoint = new URL('https://www.youtube.com/oembed');
  endpoint.searchParams.set('url', url.toString());
  endpoint.searchParams.set('format', 'json');
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return undefined;
    const payload = await response.json() as { title?: unknown };
    return sanitizeImportTitle(typeof payload.title === 'string' ? payload.title : undefined);
  } catch {
    return undefined;
  }
}

function sanitizeImportTitle(value?: string): string | undefined {
  const normalized = value?.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 180) : undefined;
}

function providerTitle(provider: string): string {
  return provider === 'google-drive' ? 'Google Drive' : 'Loom';
}

function displayTitleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').trim() || filename;
}

function youtubeId(url: URL): string | null {
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null;
  const queryId = url.searchParams.get('v');
  if (queryId) return queryId;
  const [kind, id] = url.pathname.split('/').filter(Boolean);
  return ['shorts', 'embed', 'live'].includes(kind ?? '') ? id ?? null : null;
}

function directVideoSuffix(url: URL): string | undefined {
  const pathname = url.pathname.toLowerCase();
  return [...DIRECT_VIDEO_SUFFIXES].find((suffix) => pathname.endsWith(suffix));
}

function loomId(url: URL): string | undefined {
  const parts = url.pathname.split('/').filter(Boolean);
  const candidate = parts.at(-1);
  return candidate && /^[A-Za-z0-9_-]{6,128}$/.test(candidate) ? candidate.slice(0, 80) : undefined;
}

function googleDriveId(url: URL): string | undefined {
  const fromQuery = url.searchParams.get('id');
  if (fromQuery && /^[A-Za-z0-9_-]{6,128}$/.test(fromQuery)) return fromQuery.slice(0, 80);
  const match = /\/file\/d\/([A-Za-z0-9_-]{6,128})/.exec(url.pathname);
  return match?.[1]?.slice(0, 80);
}

function safeImportFilename(value: string): string {
  return (value.replace(/[\u0000-\u001f\u007f-\u009f/\\]/g, '').trim() || 'import.mp4').slice(0, 255);
}

function mimeTypeForContainer(container: string): string {
  if (container === 'mov') return 'video/quicktime';
  if (container === 'webm') return 'video/webm';
  if (container === 'mkv') return 'video/x-matroska';
  if (container === 'avi') return 'video/x-msvideo';
  return 'video/mp4';
}

function isPrivateHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return true;
  }
  const version = isIP(hostname);
  if (version === 4) {
    const [a = 0, b = 0] = hostname.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) {
    const normalized = hostname.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }
  return false;
}
