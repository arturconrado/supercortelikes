import { PrismaClient } from '@prisma/client';

const query = process.argv[2];
if (!query) throw new Error('Usage: node scripts/support/inspect-customer.mjs <email|workspace-id>');

const prisma = new PrismaClient();
try {
  const workspace = query.includes('@')
    ? await prisma.workspace.findFirst({
        where: { members: { some: { user: { email: query.toLowerCase() } } } },
        include: {
          owner: { select: { id: true, email: true, displayName: true, emailVerifiedAt: true } },
          subscriptions: { orderBy: { createdAt: 'desc' }, take: 3 },
          _count: { select: { videos: true, projects: true, usageEvents: true } },
        },
      })
    : await prisma.workspace.findUnique({
        where: { id: query },
        include: {
          owner: { select: { id: true, email: true, displayName: true, emailVerifiedAt: true } },
          subscriptions: { orderBy: { createdAt: 'desc' }, take: 3 },
          _count: { select: { videos: true, projects: true, usageEvents: true } },
        },
      });
  if (!workspace) throw new Error('Workspace not found');
  const [openDlq, pendingOutbox, usage] = await Promise.all([
    prisma.deadLetterJob.count({ where: { status: 'OPEN', pipelineRun: { video: { workspaceId: workspace.id } } } }),
    prisma.outboxEvent.count({ where: { publishedAt: null, aggregateId: { in: await videoIds(workspace.id) } } }),
    prisma.usageEvent.aggregate({
      where: { workspaceId: workspace.id, type: 'processing.minutes' },
      _sum: { quantity: true, costCents: true },
    }),
  ]);
  console.log(JSON.stringify({
    id: workspace.id,
    name: workspace.name,
    plan: workspace.plan,
    owner: workspace.owner,
    counts: workspace._count,
    subscriptions: workspace.subscriptions,
    openDlq,
    pendingOutbox,
    processingMinutes: usage._sum.quantity?.toString() ?? '0',
    costCents: usage._sum.costCents ?? 0,
  }, null, 2));
} finally {
  await prisma.$disconnect();
}

async function videoIds(workspaceId) {
  return (await prisma.video.findMany({ where: { workspaceId }, select: { id: true } })).map((video) => video.id);
}
