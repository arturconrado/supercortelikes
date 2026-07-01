import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';

const apiUrl = (process.env.ACCEPTANCE_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const fixture = process.env.ACCEPTANCE_VIDEO_PATH ?? '/tmp/clipbr-recovery-fixture.mp4';
const timeoutMs = Number(process.env.ACCEPTANCE_TIMEOUT_MS ?? 45 * 60 * 1000);
const uploadMode = process.env.ACCEPTANCE_UPLOAD_MODE ?? 'stream';
const projectName = process.env.COMPOSE_PROJECT_NAME ?? 'clipbr-local';
const composeFile = process.env.ACCEPTANCE_COMPOSE_FILE;
const mediaProfile = process.env.ACCEPTANCE_MEDIA_PROFILE ?? 'release';
const databaseUrl = process.env.DATABASE_URL ??
  'postgresql://clipbr_local:clipbr_local_9Tq4xV7mK2pR8sW6@localhost:5432/clipbr?schema=public';
process.env.DATABASE_URL = databaseUrl;

const prisma = new PrismaClient();
const suffix = randomUUID().slice(0, 8);
const email = `release-${suffix}@clipbr.test`;
const password = 'ReleaseGate123!';

async function request(path, init = {}, expected = 200) {
  const response = await fetch(`${apiUrl}${path}`, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (response.status !== expected) {
    throw new Error(`${init.method ?? 'GET'} ${path} returned ${response.status}: ${text}`);
  }
  return body;
}

async function waitForPipeline(videoId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await prisma.pipelineRun.findFirst({
      where: { videoId },
      orderBy: { createdAt: 'desc' },
      include: { stages: { orderBy: { createdAt: 'asc' } } },
    });
    if (run?.status === 'FAILED') {
      throw new Error(`Pipeline failed at ${run.currentStage ?? 'unknown'}: ${run.failureCode} ${run.failureMessage}`);
    }
    if (run?.status === 'SUCCEEDED') return run;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`Pipeline did not finish within ${timeoutMs}ms`);
}

async function directUpload(bytes, projectId, authorization) {
  const session = await request('/videos/presigned-upload', {
    method: 'POST',
    headers: { ...authorization, 'content-type': 'application/json', 'idempotency-key': `release-${randomUUID()}` },
    body: JSON.stringify({ filename: 'release-recovery.mp4', mimeType: 'video/mp4', sizeBytes: bytes.length, projectId }),
  }, 201);
  const parts = [];
  for (let first = 1; first <= session.partCount; first += 20) {
    const partNumbers = Array.from({ length: Math.min(20, session.partCount - first + 1) }, (_, index) => first + index);
    const signed = await request(`/videos/${session.videoId}/upload-parts`, {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: session.uploadId, partNumbers }),
    }, 201);
    for (const item of signed.parts) {
      const start = (item.partNumber - 1) * session.partSizeBytes;
      const response = await fetch(item.url, {
        method: 'PUT',
        headers: { 'content-type': 'video/mp4' },
        body: bytes.subarray(start, Math.min(bytes.length, start + session.partSizeBytes)),
      });
      if (!response.ok || !response.headers.get('etag')) throw new Error(`Storage rejected part ${item.partNumber}: ${response.status}`);
      parts.push({ partNumber: item.partNumber, etag: response.headers.get('etag') });
    }
  }
  return request('/videos/confirm-upload', {
    method: 'POST',
    headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ videoId: session.videoId, uploadId: session.uploadId, parts }),
  }, 201);
}

try {
  await request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      displayName: 'Release Gate',
      password,
      acceptedTermsVersion: 'terms-2026-06',
      acceptedPrivacyVersion: 'privacy-2026-06',
    }),
  }, 201);
  const login = await request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const authorization = { authorization: `Bearer ${login.accessToken}` };
  const project = await request('/projects', {
    method: 'POST',
    headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Release ${suffix}` }),
  }, 201);

  const bytes = await readFile(fixture);
  let video;
  if (uploadMode === 'direct') {
    video = await directUpload(bytes, project.id, authorization);
  } else {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'video/mp4' }), 'release-recovery.mp4');
    video = await request('/videos/upload', {
      method: 'POST',
      headers: {
        ...authorization,
        'idempotency-key': `release-${randomUUID()}`,
        'x-project-id': project.id,
      },
      body: form,
    }, 201);
  }

  const pipeline = await waitForPipeline(video.id);
  const retriedStages = pipeline.stages.filter((stage) => stage.attempts !== 1);
  if (retriedStages.length > 0) {
    throw new Error(`Pipeline stages retried unexpectedly: ${JSON.stringify(retriedStages.map((stage) => ({ stage: stage.stage, attempts: stage.attempts })))}`);
  }
  const [transcript, segments, scores, deadLetters, unpublished, clips] = await Promise.all([
    prisma.transcript.findUnique({ where: { videoId: video.id } }),
    prisma.segment.count({ where: { videoId: video.id } }),
    prisma.viralScore.count({ where: { segment: { videoId: video.id } } }),
    prisma.deadLetterJob.count({ where: { pipelineRunId: pipeline.id, status: 'OPEN' } }),
    prisma.outboxEvent.count({ where: { aggregateId: video.id, publishedAt: null } }),
    request(`/videos/${video.id}/clips`, { headers: authorization }),
  ]);
  if (!transcript?.fullText || segments < 1 || scores < 1) throw new Error('Transcript, segments, or scores were not persisted');
  if (deadLetters !== 0 || unpublished !== 0) throw new Error('Pipeline left open DLQ or unpublished outbox records');
  if (!Array.isArray(clips) || clips.length < 1) throw new Error('No clips were created');
  const clip = clips[0];
  if (!clip.title || !Array.isArray(clip.hashtags) || clip.hashtags.length < 1) throw new Error('Clip SEO was not persisted');
  if (!Array.isArray(clip.captions) || clip.captions.length < 1) throw new Error('Caption tracks were not persisted');
  const readyExport = clip.exports?.find((value) => value.status === 'READY');
  if (!readyExport) throw new Error('No ready export was persisted');

  const download = await request(`/exports/${readyExport.id}/download`, { headers: authorization });
  const exported = await fetch(download.url);
  if (!exported.ok) throw new Error(`Signed download returned ${exported.status}`);
  const outputPath = `/tmp/clipbr-release-export-${suffix}.mp4`;
  await writeFile(outputPath, Buffer.from(await exported.arrayBuffer()));
  const composeArgs = ['compose', ...(composeFile ? ['-f', composeFile] : []), '-p', projectName, '--profile', mediaProfile];
  const mediaContainer = execFileSync(
    'docker',
    [...composeArgs, 'ps', '-q', 'media-worker'],
    { encoding: 'utf8' },
  ).trim();
  if (!mediaContainer) throw new Error('Media worker container was not found for ffprobe validation');
  const containerOutput = `/data/acceptance-export-${suffix}.mp4`;
  execFileSync('docker', ['cp', outputPath, `${mediaContainer}:${containerOutput}`]);
  const probe = JSON.parse(execFileSync(
    'docker',
    ['exec', mediaContainer, 'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', containerOutput],
    { encoding: 'utf8' },
  ));
  const stream = probe.streams?.[0];
  if (stream?.codec_name !== 'h264' || stream.width !== 1080 || stream.height !== 1920) {
    throw new Error(`Unexpected exported video: ${JSON.stringify(stream)}`);
  }

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    account: email,
    projectId: project.id,
    videoId: video.id,
    pipelineRunId: pipeline.id,
    stages: pipeline.stages.map((stage) => ({ stage: stage.stage, status: stage.status, attempts: stage.attempts })),
    transcriptCharacters: transcript.fullText.length,
    segments,
    scores,
    clips: clips.length,
    exportId: readyExport.id,
    downloadStatus: exported.status,
    video: stream,
  }, null, 2)}\n`);
} finally {
  await prisma.$disconnect();
}
