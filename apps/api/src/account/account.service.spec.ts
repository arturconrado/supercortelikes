import * as argon2 from 'argon2';
import { describe, expect, it, vi } from 'vitest';
import { AccountService } from './account.service';

vi.mock('argon2', () => ({
  verify: vi.fn().mockResolvedValue(true),
}));

const user = {
  userId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  email: 'qa@clipbr.test',
};
const workspaceIds = [user.workspaceId];
const videoIds = ['33333333-3333-4333-8333-333333333333'];

function fixture() {
  const tx = {
    outboxEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    video: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    workspace: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    user: { delete: vi.fn().mockResolvedValue({ id: user.userId }) },
  };
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: user.userId,
        passwordHash: 'password-hash',
        ownedWorkspaces: workspaceIds.map((id) => ({ id })),
      }),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
  };
  const videos = {
    prepareWorkspaceDeletion: vi.fn().mockResolvedValue(videoIds),
  };
  return {
    service: new AccountService(prisma as never, videos as never),
    prisma,
    tx,
    videos,
  };
}

describe('AccountService', () => {
  it('deletes prepared video rows before deleting the account workspace and user', async () => {
    const { service, tx, videos } = fixture();

    await service.remove(user, 'valid-password');

    expect(argon2.verify).toHaveBeenCalledWith('password-hash', 'valid-password');
    expect(videos.prepareWorkspaceDeletion).toHaveBeenCalledWith(workspaceIds);
    expect(tx.outboxEvent.deleteMany).toHaveBeenCalledWith({
      where: { aggregateId: { in: videoIds } },
    });
    expect(tx.video.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: videoIds } },
    });
    expect(tx.workspace.deleteMany).toHaveBeenCalledWith({
      where: { ownerId: user.userId },
    });
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: user.userId } });
  });
});
