import { describe, expect, it, vi } from 'vitest';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

describe('MetricsController operational gauges', () => {
  it('removes stale export labels and resets processing age when the database has no active export', async () => {
    const metrics = new MetricsService();
    const prisma = {
      outboxEvent: { count: vi.fn().mockResolvedValue(0) },
      deadLetterJob: { count: vi.fn().mockResolvedValue(0) },
      stageExecution: { groupBy: vi.fn().mockResolvedValue([]) },
      export: {
        groupBy: vi.fn()
          .mockResolvedValueOnce([{ status: 'PROCESSING', _count: { _all: 1 } }])
          .mockResolvedValueOnce([{ status: 'READY', _count: { _all: 18 } }]),
        findFirst: vi.fn()
          .mockResolvedValueOnce({ updatedAt: new Date(Date.now() - 31 * 60 * 1000) })
          .mockResolvedValueOnce(null),
      },
    };
    const queues = { diagnostics: vi.fn().mockResolvedValue({ rendering: { waiting: 0, active: 0, delayed: 0, failed: 0 } }) };
    const controller = new MetricsController(metrics, prisma as never, queues as never);
    const reply = {
      type: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    await controller.get(reply as never);
    expect(await metrics.registry.getSingleMetricAsString('clipbr_export_jobs')).toContain('status="PROCESSING"} 1');
    expect(await metrics.registry.getSingleMetricAsString('clipbr_oldest_processing_export_age_seconds')).toMatch(/ 18\d\d(?:\.|\n|$)/);

    await controller.get(reply as never);
    const exportsMetric = await metrics.registry.getSingleMetricAsString('clipbr_export_jobs');
    expect(exportsMetric).toContain('status="READY"} 18');
    expect(exportsMetric).not.toContain('status="PROCESSING"');
    expect(await metrics.registry.getSingleMetricAsString('clipbr_oldest_processing_export_age_seconds')).toContain(' 0');
  });
});
