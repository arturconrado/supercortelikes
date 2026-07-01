import { hostname } from 'node:os';
import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { QueueRegistryService } from './queue-registry.service';

export const workerHeartbeatKey = (instance = process.env.HOSTNAME || hostname()): string =>
  `pipeline-worker:${instance}`;

@Injectable()
export class WorkerHeartbeatService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistryService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), 10_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
    await this.queues.heartbeat(workerHeartbeatKey(), 30);
  }
}
