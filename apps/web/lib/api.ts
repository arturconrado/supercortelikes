import type { AuthResponse } from './types';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const TOKEN_KEY = 'clipbr.access-token';
const REFRESH_KEY = 'clipbr.refresh-token';
const USER_KEY = 'clipbr.user';

type RefreshTokens = { accessToken: string; refreshToken?: string; expiresInSeconds?: number };

let refreshInFlight: Promise<string> | null = null;

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

function getToken(): string | null {
  return typeof window === 'undefined' ? null : localStorage.getItem(TOKEN_KEY);
}

function getRefreshToken(): string | null {
  return typeof window === 'undefined' ? null : localStorage.getItem(REFRESH_KEY);
}

export function storeSession(session: AuthResponse): void {
  localStorage.setItem(TOKEN_KEY, session.accessToken);
  if (session.refreshToken) localStorage.setItem(REFRESH_KEY, session.refreshToken);
  localStorage.setItem(USER_KEY, JSON.stringify(session.user));
  window.dispatchEvent(new Event('clipbr:session'));
}

export function storedUser(): AuthResponse['user'] | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = localStorage.getItem(USER_KEY);
  if (!value) return undefined;
  try {
    return JSON.parse(value) as AuthResponse['user'];
  } catch {
    localStorage.removeItem(USER_KEY);
    return undefined;
  }
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
  window.dispatchEvent(new Event('clipbr:session'));
}

export function hasSession(): boolean { return Boolean(getToken() || getRefreshToken()); }

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
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response = await fetch(url, { ...init, headers, cache: 'no-store' });
  if (response.status === 401 && canRefresh(url)) {
    try {
      const accessToken = await refreshAccessToken();
      headers.set('Authorization', `Bearer ${accessToken}`);
      response = await fetch(url, { ...init, headers, cache: 'no-store' });
    } catch {
      clearSession();
    }
  }
  if (response.status === 401 && !isSessionEntry(url)) clearSession();
  return response;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authenticatedFetch(path, init);
  const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new ApiError(response.status, errorMessage(payload, response.status), payload);
  }
  return payload as T;
}

async function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = performRefresh().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function performRefresh(): Promise<string> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new Error('Refresh token is unavailable');
  const response = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    cache: 'no-store',
  });
  const payload = await response.json().catch(() => undefined) as
    | { tokens?: RefreshTokens; data?: { tokens?: RefreshTokens } }
    | undefined;
  const tokens = payload?.tokens ?? payload?.data?.tokens;
  if (!response.ok || !tokens?.accessToken) throw new Error('Unable to refresh session');
  localStorage.setItem(TOKEN_KEY, tokens.accessToken);
  if (tokens.refreshToken) localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  return tokens.accessToken;
}

function canRefresh(pathOrUrl: string): boolean {
  if (!getRefreshToken()) return false;
  return !isSessionEntry(pathOrUrl);
}

function isSessionEntry(pathOrUrl: string): boolean {
  const pathname = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')
    ? new URL(pathOrUrl).pathname
    : pathOrUrl.split('?', 1)[0];
  return ['/auth/login', '/auth/register', '/auth/refresh'].includes(pathname);
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
