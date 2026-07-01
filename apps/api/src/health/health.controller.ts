import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { QueueRegistryService } from '../queues/queue-registry.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../storage/storage.port';
import { Public } from '../auth/auth.decorators';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistryService,
    private readonly config: ConfigService<Environment, true>,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Get()
  async check(): Promise<Record<string, unknown>> {
    return this.ready();
  }

  @Get('live')
  live(): { status: 'ok'; build: string } {
    return { status: 'ok', build: this.config.get('BUILD_SHA', { infer: true }) };
  }

  @Get('ready')
  async ready(): Promise<Record<string, unknown>> {
    try {
      const [, pong, relay, storage] = await Promise.all([
        this.prisma.$queryRaw`SELECT 1`,
        this.queues.ping(),
        this.queues.heartbeatExists('outbox-relay'),
        this.storage.ready(),
      ]);
      const queues = this.queues.essentialQueuesRegistered();
      const cors = this.config.get('CORS_ORIGINS', { infer: true }).length > 0;
      const jwt = this.config.get('JWT_SECRET', { infer: true }).length >= 32;
      if (pong !== 'PONG' || !relay || !storage || !queues || !cors || !jwt) {
        throw new Error('Required infrastructure is not ready');
      }
      return {
        status: 'ok', build: this.config.get('BUILD_SHA', { infer: true }), database: 'up', redis: 'up',
        storage: 'up', outboxRelay: 'up', queues: 'registered', configuration: 'valid',
      };
    } catch {
      throw new ServiceUnavailableException('One or more required services are unavailable');
    }
  }

  @Get('pipeline')
  async pipeline(): Promise<Record<string, unknown>> {
    try {
      const [queues, unpublished, oldest, deadLettersOpen, relay] = await Promise.all([
        this.queues.diagnostics(),
        this.prisma.outboxEvent.count({ where: { publishedAt: null } }),
        this.prisma.outboxEvent.findFirst({
          where: { publishedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        this.prisma.deadLetterJob.count({ where: { status: 'OPEN' } }),
        this.queues.heartbeatExists('outbox-relay'),
      ]);
      return {
        status: relay ? 'ok' : 'degraded',
        outbox: {
          relay: relay ? 'up' : 'down',
          unpublished,
          oldestAgeMs: oldest ? Date.now() - oldest.createdAt.getTime() : 0,
        },
        queues,
        deadLettersOpen,
      };
    } catch {
      throw new ServiceUnavailableException('Pipeline diagnostics are unavailable');
    }
  }
}
