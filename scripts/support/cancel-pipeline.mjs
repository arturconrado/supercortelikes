import { PrismaClient } from '@prisma/client';

const id = process.argv[2];
if (!id) throw new Error('Usage: node scripts/support/cancel-pipeline.mjs <pipeline-run-id>');

const prisma = new PrismaClient();
try {
  await prisma.$transaction([
    prisma.stageExecution.updateMany({
      where: { pipelineRunId: id, status: { in: ['PENDING', 'QUEUED', 'PROCESSING', 'RETRYING'] } },
      data: { status: 'FAILED', errorCode: 'CANCELLED_BY_SUPPORT', errorMessage: 'Pipeline cancelled by support', completedAt: new Date() },
    }),
    prisma.pipelineRun.update({
      where: { id },
      data: { status: 'CANCELLED', currentStage: null, completedAt: new Date(), failureCode: 'CANCELLED_BY_SUPPORT', failureMessage: 'Pipeline cancelled by support' },
    }),
  ]);
  console.log(JSON.stringify({ status: 'CANCELLED', pipelineRunId: id }, null, 2));
} finally {
  await prisma.$disconnect();
}
