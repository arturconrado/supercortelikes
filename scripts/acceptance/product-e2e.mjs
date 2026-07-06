import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';

const apiUrl = (process.env.PRODUCT_E2E_API_URL ?? process.env.ACCEPTANCE_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const webUrl = (process.env.PRODUCT_E2E_WEB_URL ?? process.env.ACCEPTANCE_WEB_URL ?? '').replace(/\/$/, '');
const fixture = process.env.PRODUCT_E2E_VIDEO_PATH ?? process.env.ACCEPTANCE_VIDEO_PATH ?? '/tmp/clipbr-product-e2e.mp4';
const timeoutMs = Number(process.env.PRODUCT_E2E_TIMEOUT_MS ?? process.env.ACCEPTANCE_TIMEOUT_MS ?? 45 * 60 * 1000);
const httpTimeoutMs = Number(process.env.PRODUCT_E2E_HTTP_TIMEOUT_MS ?? 30_000);
const termsVersion = process.env.PRODUCT_E2E_TERMS_VERSION ?? 'terms-2026-06';
const privacyVersion = process.env.PRODUCT_E2E_PRIVACY_VERSION ?? 'privacy-2026-06';
const turnstileToken = process.env.PRODUCT_E2E_TURNSTILE_TOKEN;
const projectName = process.env.COMPOSE_PROJECT_NAME ?? 'clipbr-local';
const composeFile = process.env.PRODUCT_E2E_COMPOSE_FILE ?? process.env.ACCEPTANCE_COMPOSE_FILE;
const mediaProfile = process.env.PRODUCT_E2E_MEDIA_PROFILE ?? process.env.ACCEPTANCE_MEDIA_PROFILE ?? 'local-full';
const databaseUrl = process.env.DATABASE_URL ??
  'postgresql://clipbr_local:clipbr_local_9Tq4xV7mK2pR8sW6@localhost:5432/clipbr?schema=public';
process.env.DATABASE_URL = databaseUrl;

const prisma = new PrismaClient();
const suffix = randomUUID().slice(0, 8);
const password = process.env.PRODUCT_E2E_PASSWORD ?? 'ProductGate123!';
const generatedEmail = `product-e2e-${suffix}@clipbr.test`;
const existingEmail = process.env.PRODUCT_E2E_EMAIL;
const cleanup = boolEnv('PRODUCT_E2E_CLEANUP', false);
const enableBillingWrite = boolEnv('PRODUCT_E2E_ENABLE_BILLING_WRITE', false);
const generateFixture = boolEnv('PRODUCT_E2E_GENERATE_FIXTURE', true);
const skipFfprobe = boolEnv('PRODUCT_E2E_SKIP_FFPROBE', false);
const stabilitySeconds = Number(process.env.PRODUCT_E2E_STABILITY_SECONDS ?? 0);

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeJson(text) {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function expectedStatus(status, expected) {
  if (Array.isArray(expected)) return expected.includes(status);
  return status === expected;
}

async function request(path, init = {}, expected = 200) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${apiUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(httpTimeoutMs),
    });
    const text = await response.text();
    const body = safeJson(text);
    if (response.status === 429 && attempt < 3) {
      const retrySeconds = retryAfterSeconds(response.headers.get('retry-after'), text);
      await sleep(retrySeconds * 1000);
      continue;
    }
    if (!expectedStatus(response.status, expected)) {
      throw new Error(`${init.method ?? 'GET'} ${path} returned ${response.status}: ${text}`);
    }
    return { body, status: response.status, headers: response.headers };
  }
  throw new Error(`${init.method ?? 'GET'} ${path} exceeded retry budget`);
}

async function api(path, init = {}, expected = 200) {
  return (await request(path, init, expected)).body;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterSeconds(header, text) {
  const headerValue = Number(header);
  if (Number.isFinite(headerValue) && headerValue > 0) return Math.min(60, headerValue);
  const match = /retry in (\d+) seconds/i.exec(text);
  if (match) return Math.min(60, Number(match[1]) + 1);
  return 5;
}

function jsonBody(value) {
  return JSON.stringify(value);
}

function authHeaders(accessToken) {
  return { authorization: `Bearer ${accessToken}` };
}

function jsonHeaders(accessToken) {
  return { ...authHeaders(accessToken), 'content-type': 'application/json' };
}

async function optionalWebChecks() {
  if (!webUrl) return { checked: false };
  const paths = ['/', '/terms', '/privacy', '/refunds'];
  const results = [];
  for (const path of paths) {
    const response = await fetch(`${webUrl}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(httpTimeoutMs) });
    if (![200, 301, 302, 307, 308].includes(response.status)) {
      throw new Error(`Web ${path} returned ${response.status}`);
    }
    results.push({ path, status: response.status });
  }
  return { checked: true, pages: results };
}

async function healthChecks() {
  const [live, ready, pipeline] = await Promise.all([
    api('/health/live'),
    api('/health/ready'),
    api('/health/pipeline'),
  ]);
  assert(live.status === 'ok', 'API live health is not ok');
  assert(ready.status === 'ok', 'API ready health is not ok');
  assert(['ok', 'degraded'].includes(pipeline.status), 'Pipeline health returned an invalid status');
  return { live, ready, pipeline };
}

async function publicPlanChecks() {
  const plans = await api('/billing/plans');
  assert(Array.isArray(plans), 'Billing plans must be an array');
  for (const planId of ['FREE', 'PRO', 'BUSINESS']) {
    const plan = plans.find((item) => item.id === planId);
    assert(plan, `Missing public plan ${planId}`);
    assert(plan.currency === 'BRL', `${planId} must be priced in BRL`);
    assert(plan.interval === 'month', `${planId} must be monthly`);
    assert(plan.version, `${planId} must expose a version`);
    assert(plan.limits?.maxUploadBytes > 0, `${planId} must expose upload limits`);
    assert(plan.limits?.minutesPerMonth > 0, `${planId} must expose monthly minutes`);
    assert(Array.isArray(plan.features) && plan.features.length > 0, `${planId} must expose features`);
  }
  return plans;
}

async function authenticate() {
  const missingLegalEmail = `product-e2e-no-legal-${suffix}@clipbr.test`;
  await request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jsonBody({
      email: missingLegalEmail,
      displayName: 'No Legal',
      password,
      ...(turnstileToken ? { turnstileToken } : {}),
    }),
  }, 400);

  if (existingEmail) {
    const login = await api('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ email: existingEmail, password }),
    });
    assert(login.accessToken && login.refreshToken, 'Existing account login did not return tokens');
    const me = await api('/auth/me', { headers: authHeaders(login.accessToken) });
    return { email: existingEmail, login, me, createdAccount: false };
  }

  const register = await api('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jsonBody({
      email: generatedEmail,
      displayName: 'Product E2E',
      password,
      acceptedTermsVersion: termsVersion,
      acceptedPrivacyVersion: privacyVersion,
      ...(turnstileToken ? { turnstileToken } : {}),
    }),
  }, 201);
  assert(register.accessToken && register.refreshToken, 'Register did not return tokens');

  await api('/auth/email/verification', {
    method: 'POST',
    headers: jsonHeaders(register.accessToken),
    body: jsonBody({ ...(turnstileToken ? { turnstileToken } : {}) }),
  }, 204);
  await api('/auth/password/forgot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jsonBody({ email: generatedEmail, ...(turnstileToken ? { turnstileToken } : {}) }),
  }, 204);

  const refreshed = await api('/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jsonBody({ refreshToken: register.refreshToken }),
  });
  assert(refreshed.tokens?.accessToken, 'Refresh did not return a new access token');

  const login = await api('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: jsonBody({ email: generatedEmail, password }),
  });
  assert(login.accessToken && login.refreshToken, 'Login did not return tokens');

  const me = await api('/auth/me', { headers: authHeaders(login.accessToken) });
  assert(me.acceptedTermsVersion === termsVersion, 'Terms version was not persisted on the user');
  assert(me.acceptedPrivacyVersion === privacyVersion, 'Privacy version was not persisted on the user');
  assert(me.workspace?.id, 'Authenticated user has no workspace');
  return { email: generatedEmail, register, refreshed, login, me, createdAccount: true };
}

async function billingAndUsageChecks(accessToken) {
  const usage = await api('/usage/current', { headers: authHeaders(accessToken) });
  assert(usage.plan && usage.version && usage.limits && usage.usage, 'Usage snapshot is incomplete');
  assert(usage.usage.remaining >= 0, 'Usage remaining cannot be negative');

  const subscription = await api('/billing/subscription', { headers: authHeaders(accessToken) });
  assert(subscription.usage?.limits ?? subscription.limits, 'Billing subscription must include usage and limits');

  await request('/billing/checkout', {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: jsonBody({ plan: 'PRO', method: 'CARD' }),
  }, 400);

  let checkout;
  if (enableBillingWrite) {
    const idempotencyKey = `product-e2e-billing-${randomUUID()}`;
    checkout = await api('/billing/checkout', {
      method: 'POST',
      headers: { ...jsonHeaders(accessToken), 'idempotency-key': idempotencyKey },
      body: jsonBody({ plan: 'PRO', method: 'CARD' }),
    }, [200, 201]);
    const replay = await api('/billing/checkout', {
      method: 'POST',
      headers: { ...jsonHeaders(accessToken), 'idempotency-key': idempotencyKey },
      body: jsonBody({ plan: 'PRO', method: 'CARD' }),
    }, [200, 201]);
    assert(JSON.stringify(replay) === JSON.stringify(checkout), 'Billing checkout idempotency replay changed the response');
  }

  return { usage, subscription, checkout: checkout ?? { skipped: true, reason: 'PRODUCT_E2E_ENABLE_BILLING_WRITE is false' } };
}

async function createProject(accessToken) {
  const project = await api('/projects', {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: jsonBody({ name: `Product E2E ${suffix}`, description: 'Fluxo ponta a ponta do produto completo.' }),
  }, 201);
  assert(project.id, 'Project create did not return an id');
  const list = await api('/projects', { headers: authHeaders(accessToken) });
  assert(Array.isArray(list) && list.some((item) => item.id === project.id), 'Project list does not include the created project');
  return project;
}

async function quotaAndAbortChecks(accessToken, projectId, usage) {
  await request('/videos/presigned-upload', {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: jsonBody({ filename: 'missing-key.mp4', mimeType: 'video/mp4', sizeBytes: 1024, projectId }),
  }, 400);

  await request('/videos/presigned-upload', {
    method: 'POST',
    headers: { ...jsonHeaders(accessToken), 'idempotency-key': `product-e2e-too-large-${randomUUID()}` },
    body: jsonBody({
      filename: 'too-large.mp4',
      mimeType: 'video/mp4',
      sizeBytes: Number(usage.limits.maxUploadBytes) + 1,
      projectId,
    }),
  }, [402, 413]);

  const abortSession = await api('/videos/presigned-upload', {
    method: 'POST',
    headers: { ...jsonHeaders(accessToken), 'idempotency-key': `product-e2e-abort-${randomUUID()}` },
    body: jsonBody({ filename: 'abort.mp4', mimeType: 'video/mp4', sizeBytes: 1024, projectId }),
  }, 201);
  await api(`/videos/${abortSession.videoId}/upload`, { method: 'DELETE', headers: authHeaders(accessToken) }, 204);
  const aborted = await api(`/videos/${abortSession.videoId}`, { headers: authHeaders(accessToken) });
  assert(aborted.status === 'FAILED' && aborted.failureCode === 'UPLOAD_ABORTED', 'Aborted direct upload was not marked as failed');
  return { abortedVideoId: abortSession.videoId };
}

async function ensureFixture() {
  try {
    await access(fixture);
    return;
  } catch (error) {
    if (!generateFixture) throw error;
  }
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=25',
    '-f',
    'lavfi',
    '-i',
    "flite=text='A tecnologia muda rapidamente. Este teste valida um produto completo de ponta a ponta.'",
    '-t',
    '16',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
  ];
  try {
    execFileSync('ffmpeg', [...args, fixture], { stdio: 'inherit' });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      generateFixtureWithMediaWorker(args);
      return;
    }
    throw error;
  }
}

function generateFixtureWithMediaWorker(ffmpegArgs) {
  const composeArgs = ['compose', ...(composeFile ? ['-f', composeFile] : []), '-p', projectName, '--profile', mediaProfile];
  const mediaContainer = execFileSync('docker', [...composeArgs, 'ps', '-q', 'media-worker'], { encoding: 'utf8' }).trim();
  if (!mediaContainer) throw new Error('Host ffmpeg is unavailable and media-worker container was not found for fixture generation');
  const containerFixture = `/data/product-e2e-fixture-${suffix}.mp4`;
  execFileSync('docker', ['exec', mediaContainer, 'ffmpeg', '-y', ...ffmpegArgs, containerFixture], { stdio: 'inherit' });
  execFileSync('docker', ['cp', `${mediaContainer}:${containerFixture}`, fixture]);
}

async function directUpload(bytes, projectId, accessToken) {
  const idempotencyKey = `product-e2e-upload-${randomUUID()}`;
  const requestBody = {
    filename: 'product-e2e.mp4',
    mimeType: 'video/mp4',
    sizeBytes: bytes.length,
    projectId,
  };
  const session = await api('/videos/presigned-upload', {
    method: 'POST',
    headers: { ...jsonHeaders(accessToken), 'idempotency-key': idempotencyKey },
    body: jsonBody(requestBody),
  }, 201);
  const replay = await api('/videos/presigned-upload', {
    method: 'POST',
    headers: { ...jsonHeaders(accessToken), 'idempotency-key': idempotencyKey },
    body: jsonBody(requestBody),
  }, 201);
  assert(replay.videoId === session.videoId && replay.uploadId === session.uploadId, 'Direct upload create is not idempotent');

  const parts = [];
  for (let first = 1; first <= session.partCount; first += 20) {
    const partNumbers = Array.from({ length: Math.min(20, session.partCount - first + 1) }, (_, index) => first + index);
    const signed = await api(`/videos/${session.videoId}/upload-parts`, {
      method: 'POST',
      headers: jsonHeaders(accessToken),
      body: jsonBody({ uploadId: session.uploadId, partNumbers }),
    }, 201);
    assert(signed.expiresInSeconds === 900, 'Part URLs must expire in 15 minutes');
    for (const item of signed.parts) {
      const start = (item.partNumber - 1) * session.partSizeBytes;
      const body = bytes.subarray(start, Math.min(bytes.length, start + session.partSizeBytes));
      const response = await fetch(item.url, {
        method: 'PUT',
        headers: { 'content-type': 'video/mp4' },
        body,
        signal: AbortSignal.timeout(httpTimeoutMs),
      });
      const etag = response.headers.get('etag');
      if (!response.ok || !etag) throw new Error(`Storage rejected part ${item.partNumber}: ${response.status}`);
      parts.push({ partNumber: item.partNumber, etag });
    }
  }

  const video = await api('/videos/confirm-upload', {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: jsonBody({ videoId: session.videoId, uploadId: session.uploadId, parts }),
  }, 201);
  assert(video.id === session.videoId && video.status === 'UPLOADED', 'Confirmed upload did not produce an uploaded video');
  return { session, video, parts: parts.length };
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

async function waitForExport(exportId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const item = await prisma.export.findUnique({ where: { id: exportId } });
    if (item?.status === 'FAILED') {
      throw new Error(`Export ${exportId} failed: ${item.errorCode ?? 'UNKNOWN'} ${item.errorMessage ?? ''}`);
    }
    if (item?.status === 'READY' && item.storageKey) return item;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`Export ${exportId} did not become READY within ${timeoutMs}ms`);
}

async function contentAndExportChecks(accessToken, projectId, videoId, pipelineRunId) {
  const [video, project, library, transcript, segments, scores, deadLetters, unpublished, usageEvents] = await Promise.all([
    api(`/videos/${videoId}`, { headers: authHeaders(accessToken) }),
    api(`/projects/${projectId}`, { headers: authHeaders(accessToken) }),
    api(`/videos?projectId=${projectId}`, { headers: authHeaders(accessToken) }),
    prisma.transcript.findUnique({ where: { videoId } }),
    prisma.segment.count({ where: { videoId } }),
    prisma.viralScore.count({ where: { segment: { videoId } } }),
    prisma.deadLetterJob.count({ where: { pipelineRunId, status: 'OPEN' } }),
    prisma.outboxEvent.count({ where: { aggregateId: videoId, publishedAt: null } }),
    prisma.usageEvent.findMany({ where: { videoId }, orderBy: { createdAt: 'asc' } }),
  ]);
  assert(video.status === 'UPLOADED', `Video source status should stay UPLOADED after processing, got ${video.status}`);
  assert(project.videos?.some((item) => item.id === videoId), 'Project details do not include the processed video');
  assert(library.items?.some((item) => item.id === videoId), 'Library does not include the processed video');
  assert(transcript?.fullText, 'Transcript was not persisted');
  assert(segments > 0, 'Segments were not persisted');
  assert(scores > 0, 'Viral scores were not persisted');
  assert(deadLetters === 0, 'Pipeline left open DLQ records for this video');
  assert(unpublished === 0, 'Pipeline left unpublished outbox records for this video');
  assert(usageEvents.some((event) => event.type === 'processing.minutes'), 'Processing minutes usage was not recorded');

  const clips = await api(`/videos/${videoId}/clips`, { headers: authHeaders(accessToken) });
  assert(Array.isArray(clips) && clips.length > 0, 'No clips were created');
  const clip = clips[0];
  assert(clip.title, 'Clip title was not persisted');
  assert(Array.isArray(clip.hashtags) && clip.hashtags.length > 0, 'Clip hashtags were not persisted');
  assert(Array.isArray(clip.titleSuggestions) && clip.titleSuggestions.length > 0, 'Clip title suggestions were not persisted');
  assert(Array.isArray(clip.captions) && clip.captions.length > 0, 'Caption tracks were not persisted');

  const clipDetail = await api(`/clips/${clip.id}`, { headers: authHeaders(accessToken) });
  assert(clipDetail.description && Array.isArray(clipDetail.hashtags), 'Clip detail does not expose SEO metadata');
  assert(clipDetail.playbackUrl || clipDetail.thumbnailUrl, 'Clip detail should expose preview media before export');

  const requestedExport = await api('/exports', {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: jsonBody({ clipId: clip.id, format: 'MP4', aspectRatio: '9:16' }),
  }, 201);
  assert(requestedExport.id && ['QUEUED', 'PROCESSING', 'READY'].includes(requestedExport.status), 'On-demand export was not queued');
  const readyExport = await waitForExport(requestedExport.id);

  const exportReplay = await api('/exports', {
    method: 'POST',
    headers: jsonHeaders(accessToken),
    body: jsonBody({ clipId: clip.id, format: 'MP4', aspectRatio: '9:16' }),
  }, 201);
  assert(exportReplay.id === readyExport.id, 'Export create should reuse the ready on-demand export');

  const exports = await api('/exports', { headers: authHeaders(accessToken) });
  assert(Array.isArray(exports) && exports.some((item) => item.id === readyExport.id), 'Exports list does not include the ready export');

  const download = await api(`/exports/${readyExport.id}/download`, { headers: authHeaders(accessToken) });
  assert(download.url && download.expiresInSeconds === 900, 'Download endpoint did not return a signed URL');
  const exported = await fetch(download.url, { signal: AbortSignal.timeout(120_000) });
  if (!exported.ok) throw new Error(`Signed download returned ${exported.status}`);
  const outputPath = `/tmp/clipbr-product-export-${suffix}.mp4`;
  await writeFile(outputPath, Buffer.from(await exported.arrayBuffer()));
  const probe = skipFfprobe ? { skipped: true } : ffprobe(outputPath);
  const stream = probe.skipped ? undefined : probe.streams?.[0];
  if (!probe.skipped) {
    assert(stream?.codec_name === 'h264', `Unexpected exported codec: ${JSON.stringify(stream)}`);
    assert(stream.width === 720 && stream.height === 1280, `Unexpected exported dimensions: ${JSON.stringify(stream)}`);
  }

  return {
    transcriptCharacters: transcript.fullText.length,
    segments,
    scores,
    clips: clips.length,
    clipId: clip.id,
    exportId: readyExport.id,
    downloadStatus: exported.status,
    outputPath,
    video: stream ?? probe,
  };
}

function ffprobe(outputPath) {
  const args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', outputPath];
  try {
    return JSON.parse(execFileSync('ffprobe', args, { encoding: 'utf8' }));
  } catch (localError) {
    const composeArgs = ['compose', ...(composeFile ? ['-f', composeFile] : []), '-p', projectName, '--profile', mediaProfile];
    const mediaContainer = execFileSync('docker', [...composeArgs, 'ps', '-q', 'media-worker'], { encoding: 'utf8' }).trim();
    if (!mediaContainer) throw localError;
    const containerOutput = `/data/product-e2e-export-${suffix}.mp4`;
    execFileSync('docker', ['cp', outputPath, `${mediaContainer}:${containerOutput}`]);
    return JSON.parse(execFileSync(
      'docker',
      ['exec', mediaContainer, 'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', containerOutput],
      { encoding: 'utf8' },
    ));
  }
}

async function pipelineGlobalChecks() {
  const pipeline = await api('/health/pipeline');
  if (pipeline.deadLettersOpen !== 0) throw new Error(`Global DLQ is not empty: ${pipeline.deadLettersOpen}`);
  if ((pipeline.outbox?.unpublished ?? 0) !== 0) throw new Error(`Global outbox is not empty: ${pipeline.outbox.unpublished}`);
  return pipeline;
}

async function stabilityCheckIfRequested() {
  if (!stabilitySeconds) return { skipped: true };
  await new Promise((resolve) => setTimeout(resolve, stabilitySeconds * 1000));
  const composeArgs = ['compose', ...(composeFile ? ['-f', composeFile] : []), '-p', projectName, '--profile', mediaProfile];
  const ids = execFileSync('docker', [...composeArgs, 'ps', '-q'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
  assert(ids.length > 0, 'No compose containers were found for stability check');
  const containers = ids.map((id) => {
    const restartCount = execFileSync('docker', ['inspect', '-f', '{{.RestartCount}}', id], { encoding: 'utf8' }).trim();
    const status = execFileSync('docker', ['inspect', '-f', '{{.State.Status}}', id], { encoding: 'utf8' }).trim();
    const exitCode = execFileSync('docker', ['inspect', '-f', '{{.State.ExitCode}}', id], { encoding: 'utf8' }).trim();
    assert(restartCount === '0', `Container ${id} restarted ${restartCount} time(s)`);
    assert(status === 'running' || exitCode === '0', `Container ${id} is ${status} with exit code ${exitCode}`);
    return { id, restartCount: Number(restartCount), status, exitCode: Number(exitCode) };
  });
  return { seconds: stabilitySeconds, containers };
}

try {
  const web = await optionalWebChecks();
  const initialHealth = await healthChecks();
  const plans = await publicPlanChecks();
  const identity = await authenticate();
  const accessToken = identity.login.accessToken;
  const commercial = await billingAndUsageChecks(accessToken);
  const project = await createProject(accessToken);
  const quota = await quotaAndAbortChecks(accessToken, project.id, commercial.usage);
  await ensureFixture();
  const bytes = await readFile(fixture);
  const upload = await directUpload(bytes, project.id, accessToken);
  const pipeline = await waitForPipeline(upload.video.id);
  const retriedStages = pipeline.stages.filter((stage) => stage.attempts !== 1);
  if (retriedStages.length > 0) {
    throw new Error(`Pipeline stages retried unexpectedly: ${JSON.stringify(retriedStages.map((stage) => ({ stage: stage.stage, attempts: stage.attempts })))}`);
  }
  const content = await contentAndExportChecks(accessToken, project.id, upload.video.id, pipeline.id);
  const finalPipeline = await pipelineGlobalChecks();
  const finalUsage = await api('/usage/current', { headers: authHeaders(accessToken) });
  const stability = await stabilityCheckIfRequested();

  if (cleanup) {
    await api(`/videos/${upload.video.id}`, { method: 'DELETE', headers: authHeaders(accessToken) }, 204);
  }

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    suite: 'product-e2e-ga-v1',
    apiUrl,
    web,
    account: identity.email,
    createdAccount: identity.createdAccount,
    workspaceId: identity.me.workspace?.id,
    projectId: project.id,
    abortedVideoId: quota.abortedVideoId,
    videoId: upload.video.id,
    uploadParts: upload.parts,
    pipelineRunId: pipeline.id,
    stages: pipeline.stages.map((stage) => ({ stage: stage.stage, status: stage.status, attempts: stage.attempts })),
    product: content,
    plans: plans.map((plan) => ({ id: plan.id, version: plan.version, price: plan.price, exportResolution: plan.limits.exportResolution })),
    usageBefore: commercial.usage.usage,
    usageAfter: finalUsage.usage,
    billing: commercial.checkout,
    health: { initial: initialHealth, finalPipeline },
    stability,
    cleanup,
  }, null, 2)}\n`);
} finally {
  await prisma.$disconnect();
}
