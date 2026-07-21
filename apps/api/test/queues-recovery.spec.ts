import { ConflictException, NotFoundException } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  redis: { connect: vi.fn(), quit: vi.fn(), disconnect: vi.fn(), ping: vi.fn().mockResolvedValue('PONG'), set: vi.fn(), exists: vi.fn().mockResolvedValue(1), status: 'ready' },
  queue: { add: vi.fn(), close: vi.fn(), waitUntilReady: vi.fn(), getJobCounts: vi.fn().mockResolvedValue({ waiting: 1, active: 0, delayed: 0, failed: 0 }), getWorkersCount: vi.fn().mockResolvedValue(1), isPaused: vi.fn().mockResolvedValue(false) },
  processors: [] as Array<(job: any) => Promise<void>>,
}));

vi.mock('ioredis', () => ({ default: class RedisMock { constructor() { return mocks.redis; } } }));
vi.mock('bullmq', () => {
  class QueueMock { constructor() { return mocks.queue; } }
  class WorkerMock { close = vi.fn(); constructor(_name: string, processor: any) { mocks.processors.push(processor); } }
  class UnrecoverableError extends Error {}
  return { Queue: QueueMock, Worker: WorkerMock, UnrecoverableError };
});

import { DeadLetterService } from '../src/queues/dead-letter.service';
import { OutboxRelayService } from '../src/queues/outbox-relay.service';
import { PipelineOrchestratorService, errorCode, safeErrorMessage } from '../src/queues/pipeline-orchestrator.service';
import { QueueRegistryService } from '../src/queues/queue-registry.service';
import { StageWorkerFactory } from '../src/queues/stage-worker.factory';

const config = { get: vi.fn((key: string) => ({ REDIS_URL: 'redis://redis', QUEUE_PREFIX: 'clipbr', NODE_ENV: 'test', OUTBOX_POLL_INTERVAL_MS: 1000, OUTBOX_BATCH_SIZE: 10 } as any)[key]) } as any;
const job = (stage = 'ingestion') => ({
  schemaVersion: 1, eventId: '11111111-1111-4111-8111-111111111111', pipelineRunId: '22222222-2222-4222-8222-222222222222',
  stageExecutionId: '33333333-3333-4333-8333-333333333333', videoId: '44444444-4444-4444-8444-444444444444', stage,
  correlationId: '55555555-5555-4555-8555-555555555555', causationId: '66666666-6666-4666-8666-666666666666', occurredAt: new Date().toISOString(),
}) as any;
const usage = () => ({ queuePriorityForVideo: vi.fn().mockResolvedValue(10) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.processors.length = 0;
  mocks.redis.status = 'ready';
  mocks.redis.ping.mockResolvedValue('PONG');
  mocks.redis.exists.mockResolvedValue(1);
});

describe('queue registry and worker factory', () => {
  it('initializes all queues and exposes operational diagnostics', async () => {
    const registry = new QueueRegistryService(config);
    await registry.onModuleInit();
    await registry.add('ingestion', 'video.uploaded.v1', job());
    await registry.addDeadLetter('dead', { error: true });
    expect(await registry.ping()).toBe('PONG');
    await registry.heartbeat('worker', 30);
    expect(await registry.heartbeatExists('worker')).toBe(true);
    expect((await registry.diagnostics()).ingestion).toMatchObject({ workers: 1, waiting: 1, paused: false });
    await registry.onModuleDestroy();
    expect(mocks.queue.close).toHaveBeenCalled();
  });

  it('processes, retries, and terminally fails BullMQ jobs', async () => {
    const orchestrator: any = { begin: vi.fn().mockResolvedValue('started'), complete: vi.fn(), retry: vi.fn(), fail: vi.fn() };
    const dead: any = { capture: vi.fn() };
    const factory = new StageWorkerFactory(orchestrator, dead, config);
    factory.create('ingestion', vi.fn(), 1);
    await mocks.processors[0]({ data: job(), opts: { attempts: 3 }, attemptsMade: 0, id: 'job' });
    expect(orchestrator.complete).toHaveBeenCalled();

    factory.create('ingestion', vi.fn().mockRejectedValue(new Error('temporary')), 1);
    await expect(mocks.processors[1]({ data: job(), opts: { attempts: 3 }, attemptsMade: 0, id: 'job' })).rejects.toThrow('temporary');
    expect(orchestrator.retry).toHaveBeenCalled();

    factory.create('ingestion', vi.fn().mockRejectedValue(new Error('terminal')), 1);
    await expect(mocks.processors[2]({ data: job(), opts: { attempts: 1 }, attemptsMade: 0, id: 'job' })).rejects.toThrow('terminal');
    expect(orchestrator.fail).toHaveBeenCalledWith(expect.anything(), expect.any(Error), { deadLettered: true });
    expect(dead.capture).toHaveBeenCalled();
    await factory.onModuleDestroy();
  });

  it('fails user-actionable provider errors without opening DLQ', async () => {
    const orchestrator: any = { begin: vi.fn().mockResolvedValue('started'), complete: vi.fn(), retry: vi.fn(), fail: vi.fn() };
    const dead: any = { capture: vi.fn() };
    const error = Object.assign(new UnrecoverableError('O YouTube bloqueou a importação automática deste link.'), {
      code: 'URL_IMPORT_AUTH_REQUIRED',
    });
    const factory = new StageWorkerFactory(orchestrator, dead, config);
    factory.create('ingestion', vi.fn().mockRejectedValue(error), 1);

    await expect(mocks.processors[0]({ data: job(), opts: { attempts: 5 }, attemptsMade: 0, id: 'job' })).resolves.toBeUndefined();

    expect(orchestrator.fail).toHaveBeenCalledWith(expect.anything(), error, { deadLettered: false });
    expect(dead.capture).not.toHaveBeenCalled();
    await factory.onModuleDestroy();
  });

  it('fails plan-limit errors without opening DLQ', async () => {
    const orchestrator: any = { begin: vi.fn().mockResolvedValue('started'), complete: vi.fn(), retry: vi.fn(), fail: vi.fn() };
    const dead: any = { capture: vi.fn() };
    const error = Object.assign(new UnrecoverableError('O vídeo excede a duração máxima do plano atual.'), {
      code: 'PLAN_LIMIT_EXCEEDED',
    });
    const factory = new StageWorkerFactory(orchestrator, dead, config);
    factory.create('ingestion', vi.fn().mockRejectedValue(error), 1);

    await expect(mocks.processors[0]({ data: job(), opts: { attempts: 5 }, attemptsMade: 0, id: 'job' })).resolves.toBeUndefined();

    expect(orchestrator.fail).toHaveBeenCalledWith(expect.anything(), error, { deadLettered: false });
    expect(dead.capture).not.toHaveBeenCalled();
    await factory.onModuleDestroy();
  });
});

describe('pipeline orchestration', () => {
  it('claims stages and handles missing, completed, and conflicting claims', async () => {
    const prisma: any = {
      stageExecution: { findUnique: vi.fn().mockResolvedValue(null), updateMany: vi.fn(), update: vi.fn() },
      pipelineRun: { update: vi.fn() },
    };
    const service = new PipelineOrchestratorService(prisma);
    await expect(service.begin(job())).rejects.toBeInstanceOf(NotFoundException);
    prisma.stageExecution.findUnique.mockResolvedValueOnce({ status: 'SUCCEEDED' });
    expect(await service.begin(job())).toBe('already-completed');
    prisma.stageExecution.findUnique.mockResolvedValueOnce({ id: job().stageExecutionId, status: 'PENDING', startedAt: null });
    prisma.stageExecution.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await service.begin(job())).toBe('started');
    prisma.stageExecution.findUnique.mockResolvedValueOnce({ id: job().stageExecutionId, status: 'PROCESSING', startedAt: new Date() });
    prisma.stageExecution.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.begin(job())).rejects.toBeInstanceOf(ConflictException);
  });

  it('completes intermediate and final stages and records retry/failure states', async () => {
    const tx: any = {
      stageExecution: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn(), create: vi.fn() },
      outboxEvent: { create: vi.fn() }, pipelineRun: { update: vi.fn() },
    };
    const prisma: any = {
      ...tx, $transaction: vi.fn(async (value: any) => typeof value === 'function' ? value(tx) : Promise.all(value)),
      stageExecution: { ...tx.stageExecution, update: vi.fn() },
    };
    const service = new PipelineOrchestratorService(prisma);
    expect((await service.complete(job('ingestion')))?.stage).toBe('transcription');
    expect(await service.complete(job('exports'))).toBeNull();
    await service.retry(job(), Object.assign(new Error('retry'), { code: 'MEDIA_TIMEOUT' }));
    await service.fail(job(), new Error('failed'));
    expect(prisma.stageExecution.update).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(errorCode({ code: 'bad code!' })).toBe('BAD_CODE_');
    expect(errorCode(new Error())).toBe('PIPELINE_STAGE_FAILED');
    expect(safeErrorMessage(new Error('redis://secret@redis:6379\nfailed'))).not.toContain('secret');
  });

  it('continues from composition to automatic rendering only when production auto-render is enabled', async () => {
    const tx: any = {
      stageExecution: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn(), create: vi.fn() },
      outboxEvent: { create: vi.fn() }, pipelineRun: { update: vi.fn() },
    };
    const prisma: any = { ...tx, $transaction: vi.fn(async (callback: any) => callback(tx)) };
    const enabled = new PipelineOrchestratorService(prisma, { get: () => 'all' } as any);
    const disabled = new PipelineOrchestratorService(prisma, { get: () => 'off' } as any);

    expect((await enabled.complete(job('composition')))?.stage).toBe('rendering');
    expect(await disabled.complete(job('composition'))).toBeNull();
  });
});

describe('outbox relay and dead letters', () => {
  it('publishes an event without overwriting a worker processing claim', async () => {
    const event = { id: job().eventId, aggregateId: job().videoId, type: 'video.uploaded.v1', payload: job(), createdAt: new Date(), attempts: 0 };
    const prisma: any = {
      $queryRaw: vi.fn().mockResolvedValue([event]),
      $transaction: vi.fn(async (values: any[]) => Promise.all(values)),
      outboxEvent: { update: vi.fn() },
      stageExecution: { findUnique: vi.fn().mockResolvedValue({ id: job().stageExecutionId }), updateMany: vi.fn() },
      pipelineRun: { findUnique: vi.fn().mockResolvedValue({ id: job().pipelineRunId }), update: vi.fn() },
    };
    const queues: any = { add: vi.fn(), heartbeat: vi.fn() };
    const relay = new OutboxRelayService(prisma, queues, { capture: vi.fn() } as any, config, usage() as any);
    expect(await relay.dispatchBatch()).toBe(1);
    expect(queues.add).toHaveBeenCalledWith('ingestion', 'video.uploaded.v1', expect.objectContaining({ videoId: job().videoId }), 10);
    expect(prisma.stageExecution.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: job().stageExecutionId, status: 'PENDING' } }));
    expect(await relay.dispatchBatch()).toBe(1);
    relay.onModuleDestroy();
  });

  it('discards stale outbox events when the related pipeline was deleted', async () => {
    const event = { id: job().eventId, aggregateId: job().videoId, type: 'video.uploaded.v1', payload: job(), createdAt: new Date(), attempts: 0 };
    const prisma: any = {
      outboxEvent: { update: vi.fn() },
      stageExecution: { findUnique: vi.fn().mockResolvedValue({ id: job().stageExecutionId }) },
      pipelineRun: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const queues: any = { add: vi.fn(), heartbeat: vi.fn() };
    const dead = { capture: vi.fn() };
    const relay = new OutboxRelayService(prisma, queues, dead as any, config, usage() as any);
    await (relay as any).dispatchOne(event);
    expect(queues.add).not.toHaveBeenCalled();
    expect(dead.capture).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: event.id },
      data: expect.objectContaining({ publishedAt: expect.any(Date), lastError: expect.stringContaining('stale outbox event') }),
    }));
  });

  it('backs off relay failures and captures terminal events', async () => {
    const event = { id: job().eventId, aggregateId: job().videoId, type: 'unsupported', payload: {}, createdAt: new Date(), attempts: 0 };
    const prisma: any = { outboxEvent: { update: vi.fn() }, pipelineRun: {}, stageExecution: {} };
    const dead = { capture: vi.fn() };
    const relay = new OutboxRelayService(prisma, { heartbeat: vi.fn() } as any, dead as any, config, usage() as any);
    await (relay as any).dispatchOne(event);
    expect(prisma.outboxEvent.update).toHaveBeenCalled();
    await (relay as any).dispatchOne({ ...event, attempts: 4 });
    expect(dead.capture).toHaveBeenCalled();
  });

  it('captures and redrives valid dead letters while rejecting invalid ones', async () => {
    const deadRecord = { id: 'dead', status: 'OPEN', safePayload: job('captions'), stageExecutionId: job().stageExecutionId, pipelineRunId: job().pipelineRunId, errorCode: 'FAILED' };
    const prisma: any = {
      deadLetterJob: { upsert: vi.fn().mockResolvedValue(deadRecord), findUnique: vi.fn().mockResolvedValue(deadRecord), update: vi.fn() },
      stageExecution: { findUnique: vi.fn().mockResolvedValue({ id: job().stageExecutionId }), update: vi.fn() },
      pipelineRun: { findUnique: vi.fn().mockResolvedValue({ id: job().pipelineRunId }), update: vi.fn() },
      outboxEvent: { create: vi.fn() },
      $transaction: vi.fn(async (values: any[]) => Promise.all(values)),
    };
    const queues: any = { addDeadLetter: vi.fn() };
    const service = new DeadLetterService(prisma, queues);
    await service.capture('captions', 'job', job('captions'), new Error('failed'), 3);
    expect(queues.addDeadLetter).toHaveBeenCalled();
    expect(await service.redrive('dead')).toMatch(/^[0-9a-f-]{36}$/);
    prisma.deadLetterJob.findUnique.mockResolvedValueOnce(null);
    await expect(service.redrive('missing')).rejects.toBeInstanceOf(NotFoundException);
    prisma.deadLetterJob.findUnique.mockResolvedValueOnce({ ...deadRecord, status: 'REDRIVEN' });
    await expect(service.redrive('dead')).rejects.toBeInstanceOf(ConflictException);
  });

  it('captures dead letters without stale foreign keys', async () => {
    const prisma: any = {
      deadLetterJob: { upsert: vi.fn().mockResolvedValue({ id: 'dead', errorCode: 'FAILED' }) },
      stageExecution: { findUnique: vi.fn().mockResolvedValue(null) },
      pipelineRun: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const queues: any = { addDeadLetter: vi.fn() };
    const service = new DeadLetterService(prisma, queues);
    await service.capture('outbox', 'event', job(), new Error('failed'), 5);
    expect(prisma.deadLetterJob.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ pipelineRunId: null, stageExecutionId: null }),
    }));
    expect(queues.addDeadLetter).toHaveBeenCalled();
  });
});
