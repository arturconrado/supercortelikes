import { hostname } from 'node:os';
import IORedis from 'ioredis';

async function check(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  const mediaWorkerUrl = process.env.MEDIA_WORKER_URL;
  if (!redisUrl || !mediaWorkerUrl) throw new Error('Worker health environment is incomplete');

  const prefix = `${process.env.QUEUE_PREFIX ?? 'picashorts'}-${process.env.NODE_ENV ?? 'development'}`;
  const instance = process.env.HOSTNAME || hostname();
  const redis = new IORedis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    const heartbeat = await redis.exists(`${prefix}:heartbeat:pipeline-worker:${instance}`);
    if (heartbeat !== 1) throw new Error('Worker heartbeat is missing');
    const response = await fetch(`${mediaWorkerUrl.replace(/\/$/, '')}/health/ready`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error('Media worker is not ready');
  } finally {
    redis.disconnect();
  }
}

void check().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Worker health failed'}\n`);
  process.exitCode = 1;
});
