import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly requests = new Counter({
    name: 'clipbr_http_requests_total',
    help: 'Total HTTP requests received by the API',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registry],
  });
  readonly duration = new Histogram({
    name: 'clipbr_http_request_duration_seconds',
    help: 'HTTP request latency in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 60],
    registers: [this.registry],
  });
  readonly outboxUnpublished = new Gauge({
    name: 'clipbr_outbox_unpublished',
    help: 'Unpublished outbox events',
    registers: [this.registry],
  });
  readonly deadLettersOpen = new Gauge({
    name: 'clipbr_dead_letters_open',
    help: 'Open dead-letter jobs',
    registers: [this.registry],
  });
  readonly queueJobs = new Gauge({
    name: 'clipbr_queue_jobs',
    help: 'BullMQ jobs by queue and state',
    labelNames: ['queue', 'state'] as const,
    registers: [this.registry],
  });
  readonly stageExecutions = new Gauge({
    name: 'clipbr_pipeline_stage_executions',
    help: 'Pipeline stage executions by stage and status',
    labelNames: ['stage', 'status'] as const,
    registers: [this.registry],
  });
  readonly exportJobs = new Gauge({
    name: 'clipbr_export_jobs',
    help: 'Export jobs by status',
    labelNames: ['status'] as const,
    registers: [this.registry],
  });
  readonly renderRequests = new Counter({
    name: 'clipbr_render_requests_total',
    help: 'On-demand render/export requests by result',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });
  readonly renderRequestDuration = new Histogram({
    name: 'clipbr_render_request_duration_seconds',
    help: 'Time spent creating or reusing an on-demand render/export request',
    labelNames: ['result'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'clipbr_' });
  }
}
