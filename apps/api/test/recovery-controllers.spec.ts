import { NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthController } from '../src/auth/auth.controller';
import { AuthGuard } from '../src/auth/auth.guard';
import { AuthService } from '../src/auth/auth.service';
import { ContentController } from '../src/content/content.controller';
import { ExportsController } from '../src/exports/exports.controller';
import { HealthController } from '../src/health/health.controller';
import { MediaWorkerClient } from '../src/media/media-worker.client';
import { MediaWorkersService } from '../src/media/media-workers.service';
import { ProjectsController } from '../src/projects/projects.controller';
import { WorkerHeartbeatService, workerHeartbeatKey } from '../src/queues/worker-heartbeat.service';

vi.mock('argon2', () => ({ argon2id: 2, hash: vi.fn().mockResolvedValue('password-hash'), verify: vi.fn().mockResolvedValue(true) }));

const user = { userId: '11111111-1111-4111-8111-111111111111', workspaceId: '22222222-2222-4222-8222-222222222222', email: 'user@test.dev' };
const config = (values: Record<string, unknown>) => ({ get: vi.fn((key: string) => values[key]) }) as any;

afterEach(() => vi.unstubAllGlobals());

describe('authentication recovery surface', () => {
  it('registers, logs in, refreshes, logs out, and returns the current identity', async () => {
    const created = { id: user.userId, email: user.email, displayName: 'Release User', passwordHash: '$argon2id$hash' };
    const tx = {
      user: { create: vi.fn().mockResolvedValue(created) },
      workspace: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    const prisma: any = {
      $transaction: vi.fn(async (callback: any) => callback(tx)),
      user: {
        findUnique: vi.fn()
          .mockResolvedValueOnce({ ...created, memberships: [{ workspaceId: user.workspaceId }], ownedWorkspaces: [] })
          .mockResolvedValueOnce({ id: user.userId, email: user.email, displayName: created.displayName, createdAt: new Date() }),
      },
      auditLog: { create: vi.fn() },
      refreshSession: {
        create: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({
          id: 'session', revokedAt: null, expiresAt: new Date(Date.now() + 60_000),
          user: { ...created, memberships: [{ workspaceId: user.workspaceId }], ownedWorkspaces: [] },
        }),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      workspace: { findUnique: vi.fn().mockResolvedValue({ id: user.workspaceId, name: 'Workspace', slug: 'workspace', plan: 'FREE' }) },
    };
    const jwt = { signAsync: vi.fn().mockResolvedValue('access-token') };
    const service = new AuthService(prisma, jwt as any, config({ JWT_ACCESS_TTL: '15m', JWT_REFRESH_DAYS: 30 }));
    const registered = await service.register({
      email: user.email,
      displayName: 'Release User',
      password: 'ReleaseGate123!',
      acceptedTermsVersion: undefined as never,
      acceptedPrivacyVersion: undefined as never,
    });
    expect(registered.tokens.accessToken).toBe('access-token');
    const logged = await service.login({ email: user.email, password: 'ReleaseGate123!' });
    expect(logged.user.workspaceId).toBe(user.workspaceId);
    expect((await service.refresh('refresh-token')).accessToken).toBe('access-token');
    await service.logout('refresh-token');
    expect((await service.me(user)).workspace).toMatchObject({ id: user.workspaceId });

    const controller = new AuthController({
      register: vi.fn().mockResolvedValue(registered), login: vi.fn().mockResolvedValue(logged),
      refresh: vi.fn().mockResolvedValue(registered.tokens), logout: vi.fn(), me: vi.fn().mockResolvedValue({ id: user.userId }),
    } as any);
    expect((await controller.register({
      email: user.email,
      displayName: 'Release User',
      password: 'ReleaseGate123!',
      acceptedTermsVersion: 'terms-2026-06',
      acceptedPrivacyVersion: 'privacy-2026-06',
    })).accessToken).toBe('access-token');
    expect((await controller.login({ email: user.email, password: 'ReleaseGate123!' })).user).toBeDefined();
    expect((await controller.refresh('refresh-token' as any)).tokens).toBeDefined();
    await controller.logout('refresh-token' as any);
    expect(await controller.me(user)).toBeDefined();
  });

  it('rejects invalid login, refresh, and bearer tokens', async () => {
    const prisma: any = { user: { findUnique: vi.fn().mockResolvedValue(null) }, refreshSession: { findUnique: vi.fn().mockResolvedValue(null) } };
    const service = new AuthService(prisma, { signAsync: vi.fn() } as any, config({ JWT_ACCESS_TTL: '15m', JWT_REFRESH_DAYS: 30 }));
    await expect(service.login({ email: user.email, password: 'wrong' })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.refresh('invalid')).rejects.toBeInstanceOf(UnauthorizedException);

    const request: any = { headers: {} };
    const context: any = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    };
    const guard = new AuthGuard({ verifyAsync: vi.fn() } as any, { getAllAndOverride: vi.fn().mockReturnValue(false) } as any);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    request.headers.authorization = 'Bearer bad';
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts public routes and a valid access token', async () => {
    const request: any = { headers: { authorization: 'Bearer valid' } };
    const context: any = { getHandler: vi.fn(), getClass: vi.fn(), switchToHttp: () => ({ getRequest: () => request }) };
    const reflector = { getAllAndOverride: vi.fn().mockReturnValueOnce(true).mockReturnValue(false) };
    const guard = new AuthGuard({ verifyAsync: vi.fn().mockResolvedValue({ type: 'access', sub: user.userId, wid: user.workspaceId, email: user.email }) } as any, reflector as any);
    expect(await guard.canActivate(context)).toBe(true);
    expect(await guard.canActivate(context)).toBe(true);
    expect(request.user).toEqual(user);
  });
});

describe('project and content controllers', () => {
  it('executes project CRUD with tenant filters', async () => {
    const project = { id: '33333333-3333-4333-8333-333333333333', workspaceId: user.workspaceId, name: 'Project', updatedAt: new Date(), _count: { videos: 2 } };
    const prisma: any = {
      project: {
        findMany: vi.fn().mockResolvedValue([project]), create: vi.fn().mockResolvedValue(project),
        findFirst: vi.fn().mockResolvedValue(project), updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue(project), deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const controller = new ProjectsController(prisma);
    expect(await controller.list(user)).toEqual([{ ...project, videosCount: 2 }]);
    expect(await controller.create(user, { name: ' Project ' })).toBe(project);
    expect(await controller.get(user, project.id)).toMatchObject({ id: project.id });
    expect(await controller.update(user, project.id, { name: 'Updated' })).toBe(project);
    await expect(controller.remove(user, project.id)).resolves.toBeUndefined();
    prisma.project.findFirst.mockResolvedValueOnce(null);
    await expect(controller.get(user, project.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists videos and exposes clip SEO, captions, and ready exports', async () => {
    const clip = {
      id: '44444444-4444-4444-8444-444444444444', startMs: 0n, endMs: 10_000n, score: 90,
      status: 'READY',
      titleSuggestions: ['Title'], seo: { description: 'Description', hashtags: ['#clipbr'], titles: ['SEO title'] },
      captions: [{ id: 'caption', srtKey: 'exports/video/clip.srt' }],
      exports: [{ id: 'export', status: 'READY', storageKey: 'exports/video/clip.mp4' }],
    };
    const prisma: any = {
      video: {
        findMany: vi.fn().mockResolvedValue([{ id: 'video', durationMs: 20_000n, _count: { clips: 1 }, pipelineRuns: [] }]),
        count: vi.fn().mockResolvedValue(1), findFirst: vi.fn().mockResolvedValue({ id: 'video' }),
      },
      $transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
      clip: { findMany: vi.fn().mockResolvedValue([clip]), findFirst: vi.fn().mockResolvedValue(clip), update: vi.fn().mockResolvedValue(clip) },
      seoMetadata: { upsert: vi.fn().mockResolvedValue({}) },
    };
    const storage = { downloadUrl: vi.fn(async (key: string) => `https://storage.test/${key}`) };
    const controller = new ContentController(
      prisma,
      { redrive: vi.fn() } as any,
      storage as any,
      { request: vi.fn() } as any,
      { get: vi.fn().mockReturnValue(['http://localhost:3000']) } as any,
    );
    expect((await controller.videos(user)) as any).toMatchObject({ total: 1, items: [{ clipsCount: 1 }] });
    expect((await controller.videoClips(user, '55555555-5555-4555-8555-555555555555')) as any[]).toMatchObject([{ hashtags: ['#clipbr'], downloadUrl: 'https://storage.test/exports/video/clip.mp4' }]);
    expect(await controller.clip(user, clip.id)).toMatchObject({ durationSeconds: 10 });
    expect(await controller.updateClip(user, clip.id, { title: 'New title' })).toMatchObject({ id: clip.id });
    prisma.video.findFirst.mockResolvedValueOnce(null);
    await expect(controller.videoClips(user, '55555555-5555-4555-8555-555555555555')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('health, exports, and media contracts', () => {
  it('reports API and pipeline readiness and converts failures to 503', async () => {
    const prisma: any = {
      $queryRaw: vi.fn().mockResolvedValue([1]),
      outboxEvent: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null) },
      deadLetterJob: { count: vi.fn().mockResolvedValue(0) },
    };
    const queues: any = { ping: vi.fn().mockResolvedValue('PONG'), heartbeatExists: vi.fn().mockResolvedValue(true), diagnostics: vi.fn().mockResolvedValue({ ingestion: { waiting: 0 } }), essentialQueuesRegistered: vi.fn().mockReturnValue(true) };
    const health = new HealthController(prisma, queues, config({ BUILD_SHA: 'test', CORS_ORIGINS: ['http://localhost'], JWT_SECRET: 'x'.repeat(32) }), { ready: vi.fn().mockResolvedValue(true) } as any);
    expect(health.live()).toEqual({ status: 'ok', build: 'test' });
    expect(await health.check()).toMatchObject({ database: 'up', redis: 'up' });
    expect(await health.pipeline()).toMatchObject({ status: 'ok', deadLettersOpen: 0 });
    queues.ping.mockRejectedValueOnce(new Error('redis down'));
    await expect(health.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('lists, downloads, retries, and deletes exports', async () => {
    const item = { id: '66666666-6666-4666-8666-666666666666', clipId: 'clip', status: 'READY', format: 'MP4', aspectRatio: '9:16', sizeBytes: 10n, storageKey: 'exports/clip.mp4', clip: { title: 'Title', videoId: 'video', video: {} } };
    const prisma: any = {
      export: { findMany: vi.fn().mockResolvedValue([item]), findFirst: vi.fn().mockResolvedValue(item), update: vi.fn(), delete: vi.fn() },
      clip: { findFirst: vi.fn().mockResolvedValue({ id: 'clip', exports: [item] }) },
      usageEvent: { create: vi.fn() },
      deadLetterJob: { findFirst: vi.fn().mockResolvedValue({ id: 'dead' }) },
    };
    const storage: any = { downloadUrl: vi.fn().mockResolvedValue('http://localhost/file'), delete: vi.fn() };
    const deadLetters: any = { redrive: vi.fn().mockResolvedValue('event') };
    const renderRequests: any = { request: vi.fn().mockResolvedValue(item) };
    const controller = new ExportsController(prisma, storage, deadLetters, renderRequests);
    expect((await controller.list(user)) as any[]).toMatchObject([{ sizeBytes: '10' }]);
    expect(await controller.create(user, { clipId: 'clip', format: 'MP4', aspectRatio: '9:16' } as any)).toMatchObject({ id: item.id });
    expect(await controller.download(user, item.id)).toEqual({ url: 'http://localhost/file', expiresInSeconds: 900 });
    expect(storage.downloadUrl).toHaveBeenCalledWith('exports/clip.mp4', 900, {
      disposition: 'attachment',
      filename: 'Title.mp4',
      contentType: 'video/mp4',
    });
    expect(await controller.retry(user, item.id)).toEqual({ eventId: 'event' });
    await expect(controller.remove(user, item.id)).resolves.toBeUndefined();
    renderRequests.request.mockRejectedValueOnce(new NotFoundException('Clip not found'));
    await expect(controller.create(user, { clipId: 'missing', format: 'MP4', aspectRatio: '9:16' } as any)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('calls media stages and propagates stable dependency errors', async () => {
    const client = new MediaWorkerClient(config({ MEDIA_WORKER_URL: 'http://media:8090/', MEDIA_WORKER_TOKEN: 'token', MEDIA_WORKER_TIMEOUT_MS: 5000 }));
    const payload = {
      schemaVersion: 1, pipelineRunId: 'run', stageExecutionId: 'stage', videoId: 'video', stage: 'ingestion', status: 'succeeded', cached: false,
      artifacts: [{ kind: 'source-video', path: '/data/source.mp4', sha256: 'a'.repeat(64), bytes: 10, media_type: 'video/mp4' }], metrics: {},
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal('fetch', fetchMock);
    const job: any = { stage: 'ingestion', pipelineRunId: 'run', stageExecutionId: 'stage', videoId: 'video' };
    expect((await client.execute(job, { bucket: 'bucket', key: 'key' }, {}, undefined)).stage).toBe('ingestion');
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ hashtags: ['#clipbr'] }) });
    expect(await client.seo('A transcript long enough for SEO')).toMatchObject({ hashtags: ['#clipbr'] });
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { code: 'MEDIA_DOWN', message: 'down' } }) });
    await expect(client.execute(job, undefined, {})).rejects.toMatchObject({ code: 'MEDIA_DOWN' });
    fetchMock.mockRejectedValueOnce(new Error('network')).mockRejectedValueOnce(new Error('network'));
    await expect(client.execute(job, undefined, {})).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('starts all workers and maintains a database-backed heartbeat', async () => {
    const factory = { create: vi.fn() };
    const processor = { process: vi.fn() };
    new MediaWorkersService(
      factory as any,
      processor as any,
      config({ PIPELINE_STAGE_CONCURRENCY_JSON: '{"ingestion":4,"transcription":2,"segmentation":3,"scoring":4,"clips":3,"captions":3,"rendering":2,"exports":3}' }),
    ).onApplicationBootstrap();
    expect(factory.create).toHaveBeenCalledTimes(8);
    const heartbeat = new WorkerHeartbeatService({ $queryRaw: vi.fn() } as any, { heartbeat: vi.fn() } as any);
    await heartbeat.refresh();
    expect(workerHeartbeatKey('instance')).toBe('pipeline-worker:instance');
    await heartbeat.onApplicationBootstrap();
    heartbeat.onModuleDestroy();
  });
});
