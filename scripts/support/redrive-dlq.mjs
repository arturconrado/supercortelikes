import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const id = process.argv[2];
if (!id) throw new Error('Usage: node scripts/support/redrive-dlq.mjs <dead-letter-id>');

const stages = ['ingestion', 'transcription', 'segmentation', 'scoring', 'clips', 'captions', 'rendering', 'exports'];
const prisma = new PrismaClient();
try {
  const deadLetter = await prisma.deadLetterJob.findUnique({ where: { id } });
  if (!deadLetter) throw new Error('Dead letter not found');
  if (deadLetter.status !== 'OPEN') throw new Error('Only OPEN dead letters can be redriven');
  if (!deadLetter.stageExecutionId || !deadLetter.pipelineRunId) throw new Error('Dead letter is not tied to a pipeline stage');
  const payload = deadLetter.safePayload;
  if (!payload?.stage || !payload?.videoId) throw new Error('Dead letter payload is not a pipeline job');
  const eventId = randomUUID();
  const stageIndex = stages.indexOf(payload.stage);
  const previousStage = stageIndex > 0 ? stages[stageIndex - 1] : null;
  const eventType = previousStage ? `pipeline.${previousStage}.completed.v1` : 'video.uploaded.v1';
  const job = { ...payload, eventId, causationId: payload.eventId, occurredAt: new Date().toISOString() };
  await prisma.$transaction([
    prisma.deadLetterJob.update({
      where: { id },
      data: { status: 'REDRIVEN', redriveCount: { increment: 1 }, resolvedAt: new Date() },
    }),
    prisma.stageExecution.update({
      where: { id: deadLetter.stageExecutionId },
      data: { status: 'PENDING', jobId: eventId, errorCode: null, errorMessage: null, completedAt: null },
    }),
    prisma.pipelineRun.update({
      where: { id: deadLetter.pipelineRunId },
      data: { status: 'RUNNING', completedAt: null, failureCode: null, failureMessage: null },
    }),
    prisma.outboxEvent.create({
      data: { id: eventId, aggregateId: payload.videoId, type: eventType, payload: job },
    }),
  ]);
  console.log(JSON.stringify({ status: 'REDRIVEN', deadLetterId: id, eventId, eventType }, null, 2));
} finally {
  await prisma.$disconnect();
}
