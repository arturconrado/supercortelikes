import { randomUUID } from 'node:crypto';

const apiUrl = (process.env.ACCEPTANCE_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
let accessToken = process.env.ACCEPTANCE_ACCESS_TOKEN;
const existingEmail = process.env.ACCEPTANCE_EMAIL;
const password = process.env.ACCEPTANCE_PASSWORD ?? 'ReleaseGate123!';
const turnstileToken = process.env.ACCEPTANCE_TURNSTILE_TOKEN;
const sizeBytes = Number(process.env.ACCEPTANCE_SIZE_BYTES ?? 5 * 1024 ** 3);
if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 12) throw new Error('ACCEPTANCE_SIZE_BYTES is invalid');

async function api(path, init, expected = 201) {
  const response = await fetch(`${apiUrl}${path}`, init);
  const text = await response.text();
  if (response.status !== expected) throw new Error(`${path} returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

if (!accessToken) {
  const email = existingEmail ?? `five-gib-${randomUUID().slice(0, 8)}@clipbr.test`;
  if (!existingEmail) {
    await api('/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        displayName: 'Five GiB Gate',
        acceptedTermsVersion: 'terms-2026-06',
        acceptedPrivacyVersion: 'privacy-2026-06',
        ...(turnstileToken ? { turnstileToken } : {}),
      }),
    });
  }
  const login = await api('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }, 200);
  accessToken = login.accessToken;
}
const authHeaders = { authorization: `Bearer ${accessToken}` };
const jsonHeaders = { ...authHeaders, 'content-type': 'application/json' };

const session = await api('/videos/presigned-upload', {
  method: 'POST',
  headers: { ...jsonHeaders, 'idempotency-key': `five-gib-${randomUUID()}` },
  body: JSON.stringify({ filename: 'five-gib.mp4', mimeType: 'video/mp4', sizeBytes }),
});
const chunk = Buffer.alloc(session.partSizeBytes);
chunk.set(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')]), 0);
const parts = [];
for (let offset = 0; offset < session.partCount; offset += 20) {
  const partNumbers = Array.from({ length: Math.min(20, session.partCount - offset) }, (_, index) => offset + index + 1);
  const signed = await api(`/videos/${session.videoId}/upload-parts`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ uploadId: session.uploadId, partNumbers }),
  });
  for (const item of signed.parts) {
    const remaining = sizeBytes - (item.partNumber - 1) * session.partSizeBytes;
    const body = remaining < chunk.length ? chunk.subarray(0, remaining) : chunk;
    const response = await fetch(item.url, { method: 'PUT', headers: { 'content-type': 'video/mp4' }, body });
    const etag = response.headers.get('etag');
    if (!response.ok || !etag) throw new Error(`Part ${item.partNumber} failed with ${response.status}`);
    parts.push({ partNumber: item.partNumber, etag });
  }
}
const video = await api('/videos/confirm-upload', {
  method: 'POST', headers: jsonHeaders, body: JSON.stringify({ videoId: session.videoId, uploadId: session.uploadId, parts }),
});
if (video.sizeBytes !== String(sizeBytes) || video.status !== 'UPLOADED') {
  throw new Error(`Unexpected completion: ${JSON.stringify(video)}`);
}
await api(`/videos/${video.id}`, { method: 'DELETE', headers: authHeaders }, 204);
process.stdout.write(`${JSON.stringify({ status: 'PASS', videoId: video.id, sizeBytes: video.sizeBytes, parts: parts.length })}\n`);
