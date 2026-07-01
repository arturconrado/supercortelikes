import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const startedAt = process.hrtime.bigint();
    return next.handle().pipe(
      finalize(() => {
        const route = request.routeOptions?.url ?? 'unmatched';
        const labels = { method: request.method, route, status: String(reply.statusCode) };
        this.metrics.requests.inc(labels);
        this.metrics.duration.observe(labels, Number(process.hrtime.bigint() - startedAt) / 1_000_000_000);
      }),
    );
  }
}
