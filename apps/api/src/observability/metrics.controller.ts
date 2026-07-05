import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../auth/auth.decorators';
import { PrismaService } from '../database/prisma.service';
import { QueueRegistryService } from '../queues/queue-registry.service';
import { MetricsService } from './metrics.service';

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistryService,
  ) {}

  @Get()
  async get(@Res() reply: FastifyReply): Promise<void> {
    await this.collectOperationalMetrics();
    reply.type(this.metrics.registry.contentType).send(await this.metrics.registry.metrics());
  }

  private async collectOperationalMetrics(): Promise<void> {
    const [unpublished, deadLetters, queues, stages, exports] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { publishedAt: null } }),
      this.prisma.deadLetterJob.count({ where: { status: 'OPEN' } }),
      this.queues.diagnostics(),
      this.prisma.stageExecution.groupBy({
        by: ['stage', 'status'],
        _count: { _all: true },
      }),
      this.prisma.export.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);
    this.metrics.outboxUnpublished.set(unpublished);
    this.metrics.deadLettersOpen.set(deadLetters);
    for (const [queue, values] of Object.entries(queues)) {
      this.metrics.queueJobs.set({ queue, state: 'waiting' }, values.waiting);
      this.metrics.queueJobs.set({ queue, state: 'active' }, values.active);
      this.metrics.queueJobs.set({ queue, state: 'delayed' }, values.delayed);
      this.metrics.queueJobs.set({ queue, state: 'failed' }, values.failed);
    }
    for (const item of stages) {
      this.metrics.stageExecutions.set({ stage: item.stage, status: item.status }, item._count._all);
    }
    for (const item of exports) {
      this.metrics.exportJobs.set({ status: item.status }, item._count._all);
    }
  }
}
