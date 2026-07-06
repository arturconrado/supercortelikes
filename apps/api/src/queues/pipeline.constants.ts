import type { JobsOptions } from 'bullmq';
import { z } from 'zod';

export const PIPELINE_STAGES = [
  'ingestion',
  'transcription',
  'segmentation',
  'scoring',
  'clips',
  'captions',
  'rendering',
  'exports',
] as const;

export type PipelineStageName = (typeof PIPELINE_STAGES)[number];
export type QueueName = PipelineStageName | 'dead-letter';

export const ALL_QUEUE_NAMES: readonly QueueName[] = [...PIPELINE_STAGES, 'dead-letter'];

export const pipelineJobSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  eventId: z.string().uuid(),
  pipelineRunId: z.string().uuid(),
  stageExecutionId: z.string().uuid(),
  videoId: z.string().uuid(),
  tenantId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  sourceObjectKey: z.string().min(1).optional(),
  clipId: z.string().uuid().optional(),
  exportId: z.string().uuid().optional(),
  sourcePipelineRunId: z.string().uuid().optional(),
  renderFingerprint: z.string().min(16).max(256).optional(),
  stage: z.enum(PIPELINE_STAGES),
  correlationId: z.string().uuid(),
  causationId: z.string().uuid(),
  occurredAt: z.string().datetime(),
}).superRefine((value, context) => {
  if (value.schemaVersion === 2) {
    if (!value.tenantId) context.addIssue({ code: 'custom', path: ['tenantId'], message: 'tenantId is required in v2' });
    if (!value.sourceObjectKey) context.addIssue({ code: 'custom', path: ['sourceObjectKey'], message: 'sourceObjectKey is required in v2' });
  }
});

export type PipelineJob = z.infer<typeof pipelineJobSchema>;

const eventRoutes: Readonly<Record<string, PipelineStageName>> = {
  'video.uploaded': 'ingestion',
  'video.uploaded.v1': 'ingestion',
  'video.uploaded.v2': 'ingestion',
  'pipeline.ingestion.completed.v1': 'transcription',
  'pipeline.transcription.completed.v1': 'segmentation',
  'pipeline.segmentation.completed.v1': 'scoring',
  'pipeline.scoring.completed.v1': 'clips',
  'pipeline.clips.completed.v1': 'captions',
  'clip.render.requested.v1': 'rendering',
  'pipeline.rendering.completed.v1': 'exports',
};

export function eventQueue(eventType: string): PipelineStageName {
  const queue = eventRoutes[eventType];
  if (!queue) throw new Error(`Unsupported outbox event type: ${eventType}`);
  return queue;
}

const attemptsByQueue: Readonly<Record<PipelineStageName, number>> = {
  ingestion: 5,
  transcription: 4,
  segmentation: 4,
  scoring: 3,
  clips: 3,
  captions: 3,
  rendering: 3,
  exports: 5,
};

const backoffByQueue: Readonly<Record<PipelineStageName, number>> = {
  ingestion: 5_000,
  transcription: 30_000,
  segmentation: 15_000,
  scoring: 10_000,
  clips: 10_000,
  captions: 15_000,
  rendering: 60_000,
  exports: 10_000,
};

export function queueJobOptions(queue: PipelineStageName, jobId: string, priority?: number): JobsOptions {
  return {
    jobId,
    attempts: attemptsByQueue[queue],
    ...(priority ? { priority } : {}),
    backoff: { type: 'exponential', delay: backoffByQueue[queue] },
    removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10_000 },
    removeOnFail: { age: 30 * 24 * 60 * 60, count: 100_000 },
  };
}

export function nextStage(stage: PipelineStageName): PipelineStageName | null {
  if (stage === 'captions') return null;
  const index = PIPELINE_STAGES.indexOf(stage);
  return index === PIPELINE_STAGES.length - 1 ? null : PIPELINE_STAGES[index + 1];
}

export function completedEventType(stage: PipelineStageName): string {
  return `pipeline.${stage}.completed.v1`;
}

export function prismaStage(stage: PipelineStageName): Uppercase<PipelineStageName> {
  return stage.toUpperCase() as Uppercase<PipelineStageName>;
}
