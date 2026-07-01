import { PrismaClient } from '@prisma/client';

const hours = Number(process.env.ORPHAN_UPLOAD_HOURS ?? 48);
const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
const prisma = new PrismaClient();
try {
  const attempts = await prisma.uploadAttempt.findMany({
    where: { status: 'STARTED', startedAt: { lt: cutoff } },
    include: { video: true },
    take: 500,
  });
  for (const attempt of attempts) {
    await prisma.$transaction([
      prisma.uploadAttempt.update({
        where: { id: attempt.id },
        data: { status: 'FAILED', failureCode: 'ORPHAN_UPLOAD_EXPIRED', completedAt: new Date() },
      }),
      prisma.video.update({
        where: { id: attempt.videoId },
        data: { status: 'FAILED', failureCode: 'ORPHAN_UPLOAD_EXPIRED', failureMessage: 'Upload session expired before completion' },
      }),
    ]);
  }
  console.log(JSON.stringify({ status: 'OK', cutoff: cutoff.toISOString(), failedAttempts: attempts.length }, null, 2));
} finally {
  await prisma.$disconnect();
}
