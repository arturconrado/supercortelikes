import { api } from './api';
import type { PlanLimits, Video, VideoProcessingOptions } from './types';

const MAX_BYTES = 5 * 1024 ** 3;
const acceptedExtensions = ['mp4', 'mov', 'webm', 'mkv', 'avi'];
const mimeByExtension: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
};

type MultipartSession = {
  videoId: string;
  uploadId: string;
  storageKey: string;
  partSizeBytes: number;
  partCount: number;
  expiresAt: string;
  completed?: boolean;
};

type UploadState = MultipartSession & {
  idempotencyKey: string;
  completedParts: Record<string, string>;
};

export function validateVideo(file: File, limits?: Pick<PlanLimits, 'maxUploadBytes'>): string | null {
  const maxBytes = limits?.maxUploadBytes ?? MAX_BYTES;
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!extension || !acceptedExtensions.includes(extension)) return 'Use um arquivo MP4, MOV, WEBM, MKV ou AVI.';
  if (file.size > maxBytes) return `O arquivo ultrapassa o limite do seu plano (${formatLimit(maxBytes)}).`;
  if (!file.size) return 'O arquivo está vazio.';
  if (file.type && file.type !== mimeByExtension[extension]) return 'O tipo do arquivo não corresponde à extensão.';
  return null;
}

export async function uploadVideo(
  file: File,
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
  limits?: Pick<PlanLimits, 'maxUploadBytes'>,
  processingOptions?: VideoProcessingOptions,
): Promise<Video> {
  const validation = validateVideo(file, limits);
  if (validation) throw new Error(validation);
  const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
  const stateKey = `clipbr.direct-upload.${fingerprint}`;
  let state = restoreState(stateKey);
  if (state && new Date(state.expiresAt).getTime() <= Date.now()) {
    sessionStorage.removeItem(stateKey);
    state = undefined;
  }
  const idempotencyKey = state?.idempotencyKey ?? crypto.randomUUID();
  const extension = file.name.split('.').pop()!.toLowerCase();
  const session = await api<MultipartSession>('/videos/presigned-upload', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ filename: file.name, mimeType: mimeByExtension[extension], sizeBytes: file.size, processingOptions }),
  });
  if (session.completed) {
    sessionStorage.removeItem(stateKey);
    return api<Video>(`/videos/${session.videoId}`);
  }
  state = state?.uploadId === session.uploadId
    ? { ...state, ...session, idempotencyKey }
    : { ...session, idempotencyKey, completedParts: {} };
  persistState(stateKey, state);

  const loadedByPart = new Map<number, number>();
  for (const partNumber of Object.keys(state.completedParts).map(Number)) {
    loadedByPart.set(partNumber, partLength(file.size, state.partSizeBytes, partNumber));
  }
  const reportProgress = () => {
    const loaded = [...loadedByPart.values()].reduce((total, value) => total + value, 0);
    onProgress(Math.min(99, Math.round(loaded / file.size * 100)));
  };
  reportProgress();

  try {
    const pending = Array.from({ length: state.partCount }, (_, index) => index + 1)
      .filter((partNumber) => !state!.completedParts[String(partNumber)]);
    for (let offset = 0; offset < pending.length; offset += 20) {
      assertNotAborted(signal);
      const batch = pending.slice(offset, offset + 20);
      const signed = await api<{ parts: Array<{ partNumber: number; url: string }> }>(
        `/videos/${state.videoId}/upload-parts`,
        { method: 'POST', body: JSON.stringify({ uploadId: state.uploadId, partNumbers: batch }) },
      );
      let cursor = 0;
      const workers = Array.from({ length: Math.min(2, signed.parts.length) }, async () => {
        while (cursor < signed.parts.length) {
          const item = signed.parts[cursor++];
          if (!item) break;
          const start = (item.partNumber - 1) * state!.partSizeBytes;
          const body = file.slice(start, Math.min(file.size, start + state!.partSizeBytes));
          const progress = (loaded: number) => { loadedByPart.set(item.partNumber, loaded); reportProgress(); };
          let etag: string;
          try {
            etag = await uploadPartWithRetry(item.url, body, progress, signal);
          } catch (error) {
            if (isAbort(error)) throw error;
            const renewed = await api<{ parts: Array<{ partNumber: number; url: string }> }>(
              `/videos/${state!.videoId}/upload-parts`,
              { method: 'POST', body: JSON.stringify({ uploadId: state!.uploadId, partNumbers: [item.partNumber] }) },
            );
            etag = await uploadPartWithRetry(renewed.parts[0]!.url, body, progress, signal);
          }
          state!.completedParts[String(item.partNumber)] = etag;
          persistState(stateKey, state!);
        }
      });
      await Promise.all(workers);
    }

    const parts = Object.entries(state.completedParts)
      .map(([partNumber, etag]) => ({ partNumber: Number(partNumber), etag }))
      .sort((left, right) => left.partNumber - right.partNumber);
    const video = await api<Video>('/videos/confirm-upload', {
      method: 'POST',
      body: JSON.stringify({ videoId: state.videoId, uploadId: state.uploadId, parts }),
    });
    sessionStorage.removeItem(stateKey);
    onProgress(100);
    return video;
  } catch (error) {
    if (isAbort(error)) {
      await api<void>(`/videos/${state.videoId}/upload`, { method: 'DELETE' }).catch(() => undefined);
      sessionStorage.removeItem(stateKey);
    }
    throw error;
  }
}

function formatLimit(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${Math.round(bytes / 1024 ** 3)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function uploadPartWithRetry(
  url: string,
  body: Blob,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return retry(async () => uploadPart(url, body, onProgress, signal), signal);
}

async function retry<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    assertNotAborted(signal);
    try {
      return await operation();
    } catch (error) {
      if (isAbort(error)) throw error;
      lastError = error;
      if (attempt < 2) await delay(2 ** attempt * 1000, signal);
    }
  }
  throw lastError;
}

function uploadPart(url: string, body: Blob, onProgress: (loaded: number) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.upload.onprogress = (event) => event.lengthComputable && onProgress(event.loaded);
    request.onerror = () => reject(new Error('A parte do vídeo não pôde ser enviada.'));
    request.onabort = () => reject(new DOMException('Upload cancelado.', 'AbortError'));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        const etag = request.getResponseHeader('ETag');
        if (!etag) reject(new Error('O storage não retornou o ETag da parte enviada.'));
        else resolve(etag);
      } else {
        reject(new Error(`O storage recusou uma parte do vídeo (${request.status}).`));
      }
    };
    signal?.addEventListener('abort', () => request.abort(), { once: true });
    request.send(body);
  });
}

function restoreState(key: string): UploadState | undefined {
  try {
    const value = sessionStorage.getItem(key);
    return value ? JSON.parse(value) as UploadState : undefined;
  } catch {
    sessionStorage.removeItem(key);
    return undefined;
  }
}

function persistState(key: string, state: UploadState): void {
  sessionStorage.setItem(key, JSON.stringify(state));
}

function partLength(total: number, partSize: number, partNumber: number): number {
  const start = (partNumber - 1) * partSize;
  return Math.max(0, Math.min(partSize, total - start));
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Upload cancelado.', 'AbortError');
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Upload cancelado.', 'AbortError'));
    }, { once: true });
  });
}
