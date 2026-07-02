import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { Environment } from '../config/env';
import type { PipelineJob } from '../queues/pipeline.constants';

const artifactSchema = z.object({
  kind: z.string(),
  path: z.string(),
  sha256: z.string().length(64),
  bytes: z.number().int().nonnegative(),
  media_type: z.string(),
});

const stageResponseSchema = z.object({
  schemaVersion: z.literal(1),
  pipelineRunId: z.string(),
  stageExecutionId: z.string(),
  videoId: z.string(),
  stage: z.string(),
  status: z.literal('succeeded'),
  cached: z.boolean(),
  artifacts: z.array(artifactSchema),
  metrics: z.record(z.string(), z.unknown()),
});

export type MediaStageResponse = z.infer<typeof stageResponseSchema>;

@Injectable()
export class MediaWorkerClient {
  private readonly url: string;
  private readonly token?: string;
  private readonly timeout: number;

  constructor(config: ConfigService<Environment, true>) {
    this.url = config.get('MEDIA_WORKER_URL', { infer: true }).replace(/\/$/, '');
    this.token = config.get('MEDIA_WORKER_TOKEN', { infer: true });
    this.timeout = config.get('MEDIA_WORKER_TIMEOUT_MS', { infer: true });
  }

  async execute(
    job: PipelineJob,
    storage: { bucket: string; key: string } | undefined,
    options: Record<string, unknown>,
    sourceUri?: string,
  ): Promise<MediaStageResponse> {
    return this.post(`/v1/stages/${job.stage}`, {
      schemaVersion: 1,
      pipelineRunId: job.pipelineRunId,
      stageExecutionId: job.stageExecutionId,
      videoId: job.videoId,
      ...(storage ? { storage } : {}),
      ...(sourceUri ? { sourceUri } : {}),
      options,
    });
  }

  async seo(transcript: string, options: { subject?: string; audience?: string } = {}): Promise<Record<string, unknown>> {
    return this.post('/v1/seo', {
      transcript: transcript.trim() || 'Corte gerado automaticamente.',
      language: 'pt',
      ...options,
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch {
      throw new ServiceUnavailableException('Media worker is unavailable');
    }
    let payload: unknown;
    if (typeof response.text === 'function') {
      const text = await response.text();
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { error: { code: 'MEDIA_WORKER_NON_JSON_RESPONSE', message: text.slice(0, 200) || 'Media worker returned a non-JSON response' } };
      }
    } else {
      payload = await response.json();
    }
    if (!response.ok) {
      const error = payload as { error?: { code?: string; message?: string } };
      throw Object.assign(new Error(error.error?.message ?? 'Media worker stage failed'), {
        code: error.error?.code ?? 'MEDIA_WORKER_FAILED',
      });
    }
    if (path.startsWith('/v1/stages/')) return stageResponseSchema.parse(payload) as T;
    return payload as T;
  }
}
