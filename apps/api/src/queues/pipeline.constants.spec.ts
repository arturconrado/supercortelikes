import { describe, expect, it } from 'vitest';
import {
  PIPELINE_STAGES,
  completedEventType,
  eventQueue,
  nextStage,
  pipelineJobSchema,
  queueJobOptions,
} from './pipeline.constants';

const job = {
  schemaVersion: 1,
  eventId: '0821194d-b292-4c47-b1c0-0a965be9535d',
  pipelineRunId: '9da9e438-c1f4-44ba-bb06-40fe86d78c35',
  stageExecutionId: 'ba239572-e89c-4971-90b6-d83375948489',
  videoId: '76a722c9-d0ea-4d8a-a569-047413e66c41',
  stage: 'ingestion',
  correlationId: '9da9e438-c1f4-44ba-bb06-40fe86d78c35',
  causationId: '0821194d-b292-4c47-b1c0-0a965be9535d',
  occurredAt: '2026-06-21T00:00:00.000Z',
} as const;

describe('pipeline queue contracts', () => {
  it('validates the versioned job envelope', () => {
    expect(pipelineJobSchema.parse(job)).toEqual(job);
    expect(pipelineJobSchema.safeParse({ ...job, schemaVersion: 2 }).success).toBe(false);
    expect(pipelineJobSchema.safeParse({ ...job, eventId: 'unsafe:id' }).success).toBe(false);
  });

  it('routes the complete event chain through all eight queues', () => {
    expect(eventQueue('video.uploaded.v1')).toBe('ingestion');
    for (let index = 0; index < PIPELINE_STAGES.length - 1; index += 1) {
      expect(eventQueue(completedEventType(PIPELINE_STAGES[index]))).toBe(PIPELINE_STAGES[index + 1]);
    }
    expect(() => eventQueue('payload.selected.queue')).toThrow('Unsupported outbox event type');
  });

  it('provides retry, exponential backoff, and retention for every stage', () => {
    for (const stage of PIPELINE_STAGES) {
      const options = queueJobOptions(stage, job.eventId);
      expect(options.jobId).toBe(job.eventId);
      expect(options.attempts).toBeGreaterThanOrEqual(3);
      expect(options.backoff).toMatchObject({ type: 'exponential' });
      expect(options.removeOnComplete).toBeTruthy();
      expect(options.removeOnFail).toBeTruthy();
    }
  });

  it('walks stages in order and terminates after exports', () => {
    expect(nextStage('ingestion')).toBe('transcription');
    expect(nextStage('rendering')).toBe('exports');
    expect(nextStage('exports')).toBeNull();
  });
});
