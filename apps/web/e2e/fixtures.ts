import { expect, type Page, type Route } from '@playwright/test';

export const defaultUser = {
  id: 'user-1',
  name: 'Ana Demo',
  email: 'ana@clipbr.test',
  emailVerifiedAt: '2026-07-01T00:00:00.000Z',
};

export const defaultVideo = {
  id: 'video-1',
  originalFilename: 'entrevista-demo.mp4',
  title: 'Entrevista Demo',
  status: 'UPLOADED',
  mimeType: 'video/mp4',
  container: 'mp4',
  sizeBytes: '2048000',
  durationSeconds: 120,
  thumbnailUrl: 'https://storage.test/thumb.jpg',
  playbackUrl: 'https://storage.test/source.mp4',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  processingStatus: 'RUNNING',
  currentStage: 'CLIPS',
  clipsCount: 1,
};

export const defaultClip = {
  id: 'clip-1',
  videoId: defaultVideo.id,
  title: 'Gancho forte para Reels',
  status: 'READY',
  score: 91,
  startSeconds: 12,
  endSeconds: 42,
  durationSeconds: 30,
  aspectRatio: '9:16',
  thumbnailUrl: 'https://storage.test/clip-thumb.jpg',
  renderUrl: 'https://storage.test/clip.mp4',
  playbackUrl: 'https://storage.test/clip.mp4',
  downloadUrl: 'https://storage.test/clip.mp4',
  captionsUrl: 'https://storage.test/clip.srt',
  description: 'Descrição gerada',
  hashtags: ['#clipbr', '#ia'],
  titleSuggestions: ['Gancho forte para Reels', 'Como editar mais rápido'],
  genre: 'educational',
  hook: 'Você está perdendo tempo editando manualmente',
  reason: 'Tem promessa clara nos primeiros segundos.',
  captions: [
    {
      id: 'caption-1',
      template: 'podcast',
      language: 'pt',
      cues: [{ start: 0, end: 2, words: [{ word: 'Você', start: 0, end: 0.5 }] }],
      style: { primaryColor: '#ffffff', highlightColor: '#c6ff3a' },
    },
  ],
};

export const defaultUsage = {
  plan: 'FREE',
  status: 'ACTIVE',
  version: '2026-07-source-quality-v3',
  periodStart: '2026-07-01T00:00:00.000Z',
  periodEnd: '2026-08-01T00:00:00.000Z',
  usage: { minutes: 0, limit: 60, remaining: 60 },
  limits: {
    minutesPerMonth: 60,
    maxUploadBytes: 5368709120,
    maxVideoDurationSeconds: 3600,
    exportResolution: '1080p',
    watermark: false,
    queuePriority: 1,
    maxConcurrentHeavyJobs: 1,
    graceDays: 3,
  },
};

export const pipelineProcessing = {
  videoId: defaultVideo.id,
  status: 'UPLOADED',
  progress: 63,
  run: {
    currentStage: 'CLIPS',
    stages: [
      { stage: 'INGESTION', status: 'SUCCEEDED' },
      { stage: 'TRANSCRIPTION', status: 'SUCCEEDED' },
      { stage: 'SEGMENTATION', status: 'SUCCEEDED' },
      { stage: 'SCORING', status: 'SUCCEEDED' },
      { stage: 'CLIPS', status: 'PROCESSING' },
    ],
    openDeadLetters: [],
  },
};

export const pipelineFailed = {
  videoId: defaultVideo.id,
  status: 'FAILED',
  failureCode: 'URL_IMPORT_FAILED',
  failureMessage: 'Não foi possível processar o vídeo importado.',
  progress: 25,
  run: {
    currentStage: 'TRANSCRIPTION',
    stages: [
      { stage: 'INGESTION', status: 'SUCCEEDED' },
      { stage: 'TRANSCRIPTION', status: 'FAILED', errorCode: 'WHISPER_FAILED', errorMessage: 'Transcrição falhou.' },
    ],
    openDeadLetters: [
      { id: 'dlq-1', queue: 'transcription', errorCode: 'WHISPER_FAILED', errorMessage: 'Transcrição falhou.' },
    ],
  },
};

type JsonRecord = Record<string, unknown>;

export type ClipbrMockState = {
  user: typeof defaultUser;
  video: JsonRecord;
  clips: JsonRecord[];
  usage: JsonRecord;
  pipeline: JsonRecord;
  importError?: { status: number; message: string };
  registerRequests: JsonRecord[];
  importRequests: JsonRecord[];
  presignedUploadRequests: JsonRecord[];
  uploadPartRequests: JsonRecord[];
  confirmUploadRequests: JsonRecord[];
  clipPatchRequests: JsonRecord[];
  timingPatchRequests: JsonRecord[];
  captionPatchRequests: JsonRecord[];
  exportRequests: JsonRecord[];
  retryCount: number;
  meDelayMs?: number;
};

export function createMockState(overrides: Partial<ClipbrMockState> = {}): ClipbrMockState {
  return {
    user: defaultUser,
    video: structuredClone(defaultVideo),
    clips: [structuredClone(defaultClip)],
    usage: structuredClone(defaultUsage),
    pipeline: structuredClone(pipelineProcessing),
    registerRequests: [],
    importRequests: [],
    presignedUploadRequests: [],
    uploadPartRequests: [],
    confirmUploadRequests: [],
    clipPatchRequests: [],
    timingPatchRequests: [],
    captionPatchRequests: [],
    exportRequests: [],
    retryCount: 0,
    ...overrides,
  };
}

export async function loginInBrowser(page: Page, user = defaultUser) {
  await page.addInitScript((currentUser) => {
    localStorage.setItem('clipbr.access-token', 'test-token');
    localStorage.setItem('clipbr.user', JSON.stringify(currentUser));
  }, user);
}

export async function mockClipbrApi(page: Page, state: ClipbrMockState = createMockState()) {
  await page.route(/http:\/\/(127\.0\.0\.1|localhost):4010\/.*/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: corsHeaders() });
    if (path.startsWith('/storage/upload-part/')) {
      state.uploadPartRequests.push({ partUrl: path, method });
      return route.fulfill({ status: 200, headers: { ...corsHeaders(), etag: `"etag-${state.uploadPartRequests.length}"` }, body: '' });
    }
    if (path === '/auth/me') {
      if (state.meDelayMs) await new Promise((resolve) => setTimeout(resolve, state.meDelayMs));
      return fulfillJson(route, state.user);
    }
    if (path === '/auth/register') {
      const body = requestJson(request.postData());
      state.registerRequests.push(body);
      return fulfillJson(route, { accessToken: 'test-token', user: state.user });
    }
    if (path === '/auth/login') return fulfillJson(route, { accessToken: 'test-token', user: state.user });
    if (path === '/usage/current') return fulfillJson(route, state.usage);
    if (path === '/analytics/overview') return fulfillJson(route, { recentVideos: [state.video], recentProjects: [], activity: [] });
    if (path === '/videos') return fulfillJson(route, { items: [state.video], page: 1, pageSize: 24, total: 1, totalPages: 1 });
    if (path === '/videos/import') {
      const body = requestJson(request.postData());
      state.importRequests.push(body);
      if (state.importError) return fulfillJson(route, { message: state.importError.message }, state.importError.status);
      return fulfillJson(route, state.video, 201);
    }
    if (path === '/videos/presigned-upload') {
      const body = requestJson(request.postData());
      state.presignedUploadRequests.push(body);
      return fulfillJson(route, {
        videoId: state.video.id,
        uploadId: 'upload-1',
        storageKey: `videos/${state.video.id}/source.mp4`,
        partSizeBytes: 1024 * 1024,
        partCount: 1,
      }, 201);
    }
    if (path === `/videos/${state.video.id}/upload-parts`) {
      const body = requestJson(request.postData());
      state.uploadPartRequests.push(body);
      const partNumbers = Array.isArray(body.partNumbers) ? body.partNumbers : [1];
      return fulfillJson(route, {
        parts: partNumbers.map((partNumber) => ({
          partNumber,
          url: `http://localhost:4010/storage/upload-part/${partNumber}`,
        })),
      }, 201);
    }
    if (path === '/videos/confirm-upload') {
      const body = requestJson(request.postData());
      state.confirmUploadRequests.push(body);
      return fulfillJson(route, state.video, 201);
    }
    if (path === `/videos/${state.video.id}/upload` && method === 'DELETE') return route.fulfill({ status: 204, headers: corsHeaders() });
    if (path === `/videos/${state.video.id}` && method === 'GET') return fulfillJson(route, state.video);
    if (path === `/videos/${state.video.id}` && method === 'PATCH') {
      state.video = { ...state.video, ...requestJson(request.postData()) };
      return fulfillJson(route, state.video);
    }
    if (path === `/videos/${state.video.id}/pipeline`) return fulfillJson(route, state.pipeline);
    if (path === `/videos/${state.video.id}/clips`) return fulfillJson(route, state.clips);
    if (path === `/videos/${state.video.id}/retry`) {
      state.retryCount += 1;
      state.pipeline = structuredClone(pipelineProcessing);
      return fulfillJson(route, { eventId: 'retry-event-1' }, 201);
    }
    const clipMatch = /^\/clips\/([^/]+)$/.exec(path);
    if (clipMatch) {
      const clip = state.clips.find((item) => item.id === clipMatch[1]) ?? state.clips[0];
      if (method === 'GET') return fulfillJson(route, clip);
      if (method === 'PATCH') {
        const body = requestJson(request.postData());
        state.clipPatchRequests.push(body);
        Object.assign(clip, body);
        return fulfillJson(route, clip);
      }
    }
    const timingMatch = /^\/clips\/([^/]+)\/timing$/.exec(path);
    if (timingMatch) {
      const clip = state.clips.find((item) => item.id === timingMatch[1]) ?? state.clips[0];
      const body = requestJson(request.postData());
      state.timingPatchRequests.push(body);
      Object.assign(clip, body, { durationSeconds: Number(body.endSeconds) - Number(body.startSeconds) });
      return fulfillJson(route, clip);
    }
    const captionsMatch = /^\/clips\/([^/]+)\/captions$/.exec(path);
    if (captionsMatch) {
      const clip = state.clips.find((item) => item.id === captionsMatch[1]) ?? state.clips[0];
      const body = requestJson(request.postData());
      state.captionPatchRequests.push(body);
      clip.captions = [{ id: 'caption-1', language: body.language ?? 'pt', template: body.template ?? 'podcast', cues: body.cues ?? [], style: body.style }];
      return fulfillJson(route, clip);
    }
    if (/^\/clips\/[^/]+\/(export|render)$/.test(path)) {
      const body = requestJson(request.postData());
      state.exportRequests.push(body);
      return fulfillJson(route, { id: 'export-1', clipId: state.clips[0]?.id, format: body.format ?? 'MP4', aspectRatio: body.aspectRatio ?? '9:16', status: 'QUEUED', createdAt: new Date('2026-07-01T00:00:00.000Z').toISOString() }, 201);
    }
    return fulfillJson(route, { message: `Unhandled mock route: ${method} ${path}` }, 404);
  });
  return state;
}

export function assertRegisterContract(body: JsonRecord) {
  expect(body).toMatchObject({
    displayName: 'Ana Demo',
    email: 'ana@clipbr.test',
    password: 'Password12345',
    acceptedTermsVersion: 'terms-2026-06',
    acceptedPrivacyVersion: 'privacy-2026-06',
  });
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS,PUT',
    'access-control-allow-headers': 'authorization,content-type,idempotency-key',
    'access-control-expose-headers': 'etag',
  };
}

function fulfillJson(route: Route, json: unknown, status = 200) {
  return route.fulfill({ status, headers: corsHeaders(), json });
}

function requestJson(value: string | null): JsonRecord {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === 'object' ? parsed as JsonRecord : {};
}
