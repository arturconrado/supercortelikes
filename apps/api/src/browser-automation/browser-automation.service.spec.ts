import { ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAutomationService } from './browser-automation.service';

const user = { userId: 'user-1', workspaceId: 'workspace-1', email: 'user@example.com' };

function prismaFixture() {
  return {
    browserAutomationRun: {
      create: vi.fn(async (args) => ({ id: 'run-1', ...args.data })),
      findMany: vi.fn(async () => []),
    },
    marketOpportunity: {
      findFirst: vi.fn(async () => ({ id: 'opp-1' })),
    },
  };
}

describe('BrowserAutomationService', () => {
  let prisma: ReturnType<typeof prismaFixture>;
  let service: BrowserAutomationService;

  beforeEach(() => {
    prisma = prismaFixture();
    service = new BrowserAutomationService(prisma as never);
  });

  it('blocks private network navigation for browser agents', async () => {
    await expect(service.requireManualReview(user, {
      targetUrl: 'http://127.0.0.1:3000/admin',
      goal: 'Navigate to internal admin page',
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates review-required runs for sensitive submission tasks', async () => {
    const run = await service.requireManualReview(user, {
      targetUrl: 'https://example.com/submit',
      goal: 'Prepare product submission',
      opportunityId: '00000000-0000-4000-8000-000000000001',
    }) as { status: string; blockedActions: string[] };

    expect(run.status).toBe('REVIEW_REQUIRED');
    expect(run.blockedActions).toContain('publish');
  });
});
