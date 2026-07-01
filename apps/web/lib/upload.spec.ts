import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadVideo, validateVideo } from './upload';

class MockXhr {
  static instances: MockXhr[] = [];
  static outcomes: Array<'error' | number> = [];
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  status = 200;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onload: (() => void) | null = null;
  method = '';
  url = '';
  body?: Blob;

  constructor() { MockXhr.instances.push(this); }
  open(method: string, url: string) { this.method = method; this.url = url; }
  getResponseHeader(name: string) { return name.toLowerCase() === 'etag' ? '"part-etag"' : null; }
  send(body: Blob) {
    this.body = body;
    const outcome = MockXhr.outcomes.shift();
    if (outcome === 'error') { this.onerror?.(); return; }
    if (typeof outcome === 'number') this.status = outcome;
    this.upload.onprogress?.({ lengthComputable: true, loaded: body.size, total: body.size } as ProgressEvent);
    this.onload?.();
  }
  abort() { this.onabort?.(); }
}

describe('video upload', () => {
  beforeEach(() => {
    MockXhr.instances = [];
    MockXhr.outcomes = [];
    sessionStorage.clear();
    localStorage.clear();
    vi.stubGlobal('XMLHttpRequest', MockXhr);
    vi.stubGlobal('crypto', { randomUUID: () => 'idempotency-1' });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/videos/presigned-upload')) {
        return new Response(JSON.stringify({
          videoId: 'video-1', uploadId: 'upload-1', storageKey: 'videos/video-1/source.mp4',
          partSizeBytes: 64, partCount: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/videos/video-1/upload-parts')) {
        return new Response(JSON.stringify({ parts: [{ partNumber: 1, url: 'https://storage.test/part-1' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/videos/confirm-upload')) {
        return new Response(JSON.stringify({ id: 'video-1', status: 'UPLOADED' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }));
  });

  it('validates extension, MIME, empty files and maximum size', () => {
    expect(validateVideo(new File(['video'], 'episode.mp4', { type: 'video/mp4' }))).toBeNull();
    expect(validateVideo(new File(['x'], 'episode.exe'))).toContain('MP4');
    expect(validateVideo(new File([], 'empty.mov', { type: 'video/quicktime' }))).toContain('vazio');
    expect(validateVideo(new File(['x'], 'wrong.mp4', { type: 'video/quicktime' }))).toContain('tipo');
  });

  it('uploads directly to storage and confirms the multipart session', async () => {
    localStorage.setItem('clipbr.access-token', 'auth-token');
    const progress = vi.fn();
    const result = await uploadVideo(new File(['video'], 'episode.mp4', { type: 'video/mp4', lastModified: 10 }), progress);
    const request = MockXhr.instances[0];
    expect(result.id).toBe('video-1');
    expect(request.method).toBe('PUT');
    expect(request.url).toBe('https://storage.test/part-1');
    expect(request.body).toBeInstanceOf(Blob);
    expect(progress).toHaveBeenLastCalledWith(100);
    expect(sessionStorage.length).toBe(0);
  });

  it('retries three times, renews an expired signed URL and resumes', async () => {
    vi.useFakeTimers();
    MockXhr.outcomes = [500, 500, 500, 200];
    const upload = uploadVideo(new File(['video'], 'episode.mp4', { type: 'video/mp4', lastModified: 11 }), vi.fn());
    await vi.runAllTimersAsync();
    await expect(upload).resolves.toMatchObject({ id: 'video-1' });
    const signedCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/videos/video-1/upload-parts'));
    expect(MockXhr.instances).toHaveLength(4);
    expect(signedCalls).toHaveLength(2);
    vi.useRealTimers();
  });

  it('aborts the provider upload and clears resumable state', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(uploadVideo(
      new File(['video'], 'episode.mp4', { type: 'video/mp4', lastModified: 12 }),
      vi.fn(),
      controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith('/videos/video-1/upload') && init?.method === 'DELETE')).toBe(true);
    expect(sessionStorage.length).toBe(0);
  });
});
