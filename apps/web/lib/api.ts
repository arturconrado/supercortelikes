import type { AuthResponse } from './types';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const TOKEN_KEY = 'clipbr.access-token';

type RefreshTokens = { accessToken: string; refreshToken?: string; expiresInSeconds?: number };
export type ProductEventName =
  | 'signup_completed' | 'login_completed'
  | 'upload_started' | 'upload_succeeded' | 'upload_failed' | 'upload_cancelled'
  | 'import_started' | 'import_succeeded' | 'import_failed'
  | 'project_created' | 'pipeline_retried' | 'preview_opened' | 'editor_saved'
  | 'export_started' | 'export_succeeded' | 'export_failed' | 'export_downloaded'
  | 'settings_saved' | 'logout_completed';

let refreshInFlight: Promise<string> | null = null;
let accessToken: string | null = null;
let currentUser: AuthResponse['user'] | undefined;

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

function getToken(): string | null {
  return accessToken;
}

export function storeSession(session: AuthResponse): void {
  accessToken = session.accessToken;
  currentUser = session.user;
  removeLegacySession();
  window.dispatchEvent(new Event('clipbr:session'));
}

export function storedUser(): AuthResponse['user'] | undefined {
  return currentUser;
}

export function storeUser(user: AuthResponse['user']): void {
  currentUser = user;
}

export function clearSession(): void {
  const hadSession = Boolean(accessToken || currentUser || legacySessionExists());
  accessToken = null;
  currentUser = undefined;
  removeLegacySession();
  if (hadSession && typeof window !== 'undefined') window.dispatchEvent(new Event('clipbr:session'));
}

export function hasSession(): boolean { return Boolean(getToken()); }

function errorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const value = payload as Record<string, unknown>;
    const message = value.message ?? value.error;
    if (Array.isArray(message)) return message.map(translateApiMessage).join(', ');
    if (typeof message === 'string') return translateApiMessage(message);
  }
  return status === 401 ? 'Sua sessão expirou. Entre novamente.' : 'Não foi possível concluir a solicitação.';
}

function translateApiMessage(message: unknown): string {
  if (typeof message !== 'string') return 'Não foi possível concluir a solicitação.';
  const translations: Record<string, string> = {
    'displayName must be longer than or equal to 2 characters': 'O nome precisa ter pelo menos 2 caracteres.',
    'displayName must be a string': 'Informe seu nome.',
    'password must contain a lowercase letter': 'A senha precisa ter uma letra minúscula.',
    'password must contain an uppercase letter': 'A senha precisa ter uma letra maiúscula.',
    'password must contain a number': 'A senha precisa ter um número.',
    'password must be longer than or equal to 12 characters': 'A senha precisa ter pelo menos 12 caracteres.',
    'password must be a string': 'Informe uma senha.',
    'email must be an email': 'Informe um e-mail válido.',
  };
  return translations[message] ?? message;
}

export async function authenticatedFetch(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
  const url = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://') ? pathOrUrl : `${API_URL}${pathOrUrl}`;
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!headers.has('X-Requested-With')) headers.set('X-Requested-With', 'picashorts-web');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response = await fetch(url, { ...init, headers, credentials: 'include', cache: 'no-store' });
  if (response.status === 401 && canRefresh(url)) {
    try {
      const accessToken = await refreshAccessToken();
      headers.set('Authorization', `Bearer ${accessToken}`);
      response = await fetch(url, { ...init, headers, credentials: 'include', cache: 'no-store' });
    } catch {
      clearSession();
    }
  }
  if (response.status === 401 && !isSessionEntry(url)) clearSession();
  return response;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const startedEvent = apiStartedEvent(path, init.method);
  if (startedEvent) void trackProductEvent(startedEvent);
  let response: Response;
  try {
    response = await authenticatedFetch(path, init);
  } catch (error) {
    const failedEvent = apiOutcomeEvent(path, init.method, false);
    if (failedEvent) void trackProductEvent(failedEvent, { http_status: 0 });
    throw error;
  }
  const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  const outcomeEvent = apiOutcomeEvent(path, init.method, response.ok);
  if (outcomeEvent) void trackProductEvent(outcomeEvent, { http_status: response.status });
  if (!response.ok) {
    throw new ApiError(response.status, errorMessage(payload, response.status), payload);
  }
  return payload as T;
}

export async function trackProductEvent(name: ProductEventName, properties: Record<string, string | number | boolean | null> = {}): Promise<void> {
  if (typeof window === 'undefined' || !accessToken || analyticsConsent() !== 'granted') return;
  const sessionId = productSessionId();
  const body = JSON.stringify({
    eventId: crypto.randomUUID(),
    sessionId,
    name,
    route: window.location.pathname.slice(0, 240),
    occurredAt: new Date().toISOString(),
    properties,
  });
  await authenticatedFetch('/analytics/events', { method: 'POST', body }).then(() => undefined).catch(() => undefined);
}

export type AnalyticsConsent = 'granted' | 'denied' | 'unknown';

export function analyticsConsent(): AnalyticsConsent {
  if (typeof window === 'undefined') return 'unknown';
  const value = localStorage.getItem('picashorts.analytics-consent');
  return value === 'granted' || value === 'denied' ? value : 'unknown';
}

export function setAnalyticsConsent(value: Exclude<AnalyticsConsent, 'unknown'>): void {
  localStorage.setItem('picashorts.analytics-consent', value);
  window.dispatchEvent(new Event('picashorts:analytics-consent'));
}

async function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = performRefresh().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function performRefresh(): Promise<string> {
  const response = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'picashorts-web' },
    credentials: 'include',
    body: '{}',
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => undefined) as
    | { tokens?: RefreshTokens; data?: { tokens?: RefreshTokens } }
    | undefined;
  const tokens = payload?.tokens ?? payload?.data?.tokens;
  if (!response.ok || !tokens?.accessToken) throw new Error('Unable to refresh session');
  accessToken = tokens.accessToken;
  return tokens.accessToken;
}

function canRefresh(pathOrUrl: string): boolean {
  return !isSessionEntry(pathOrUrl);
}

function isSessionEntry(pathOrUrl: string): boolean {
  const pathname = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')
    ? new URL(pathOrUrl).pathname
    : pathOrUrl.split('?', 1)[0];
  return ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout'].includes(pathname);
}

function removeLegacySession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem('clipbr.refresh-token');
  localStorage.removeItem('clipbr.user');
}

function legacySessionExists(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(localStorage.getItem(TOKEN_KEY) || localStorage.getItem('clipbr.refresh-token') || localStorage.getItem('clipbr.user'));
}

let fallbackProductSessionId: string | undefined;

function productSessionId(): string {
  const key = 'picashorts.product-session';
  try {
    const stored = sessionStorage.getItem(key);
    if (stored) return stored;
    const created = crypto.randomUUID();
    sessionStorage.setItem(key, created);
    return created;
  } catch {
    fallbackProductSessionId ??= crypto.randomUUID();
    return fallbackProductSessionId;
  }
}

function apiStartedEvent(path: string, method = 'GET'): ProductEventName | undefined {
  const pathname = path.split('?', 1)[0];
  const verb = method.toUpperCase();
  if (verb === 'POST' && pathname === '/videos/import') return 'import_started';
  if (verb === 'POST' && (/^\/clips\/[^/]+\/export$/.test(pathname) || pathname === '/exports')) return 'export_started';
  return undefined;
}

function apiOutcomeEvent(path: string, method = 'GET', ok: boolean): ProductEventName | undefined {
  const pathname = path.split('?', 1)[0];
  const verb = method.toUpperCase();
  if (verb === 'POST' && pathname === '/videos/presigned-upload') return ok ? 'upload_started' : 'upload_failed';
  if (verb === 'POST' && pathname === '/videos/confirm-upload') return ok ? 'upload_succeeded' : 'upload_failed';
  if (verb === 'POST' && pathname === '/videos/import') return ok ? 'import_succeeded' : 'import_failed';
  if (verb === 'POST' && pathname === '/projects' && ok) return 'project_created';
  if (verb === 'POST' && (/^\/projects\/[^/]+\/process$/.test(pathname) || /^\/videos\/[^/]+\/retry$/.test(pathname)) && ok) return 'pipeline_retried';
  if (verb === 'POST' && /^\/clips\/[^/]+\/preview$/.test(pathname) && ok) return 'preview_opened';
  if ((verb === 'PATCH' || verb === 'PUT') && /^\/clips\/[^/]+(?:\/timing|\/captions)?$/.test(pathname) && ok) return 'editor_saved';
  if (verb === 'POST' && (/^\/clips\/[^/]+\/export$/.test(pathname) || pathname === '/exports')) return ok ? undefined : 'export_failed';
  if (verb === 'GET' && /^\/exports\/[^/]+\/download$/.test(pathname) && ok) return 'export_downloaded';
  if ((verb === 'PATCH' || verb === 'PUT' || verb === 'POST') && (pathname === '/users/me' || pathname === '/users/me/notifications' || pathname === '/brand-kits' || pathname === '/brand-kits/logo') && ok) return 'settings_saved';
  return undefined;
}

export function unwrapList<T>(payload: T[] | { data?: T[]; items?: T[]; results?: T[] }): T[] {
  if (Array.isArray(payload)) return payload;
  return payload.data ?? payload.items ?? payload.results ?? [];
}

export function unwrap<T>(payload: T | { data: T }): T {
  return payload && typeof payload === 'object' && 'data' in payload ? (payload as { data: T }).data : payload as T;
}

export const endpoints = {
  login: '/auth/login', register: '/auth/register', me: '/auth/me',
  dashboard: '/analytics/overview', analytics: '/analytics',
  videos: '/videos', upload: '/videos/presigned-upload', imports: '/videos/import',
  projects: '/projects', clips: '/clips', exports: '/exports',
  plans: '/billing/plans', subscription: '/billing/subscription', checkout: '/billing/checkout', topUps: '/billing/top-ups',
  usage: '/usage/current',
  profile: '/users/me', password: '/auth/password', brandKit: '/brand-kits', publications: '/publications',
} as const;

export { API_URL, TOKEN_KEY };
