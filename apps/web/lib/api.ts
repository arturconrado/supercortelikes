import type { AuthResponse } from './types';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const TOKEN_KEY = 'clipbr.access-token';
const REFRESH_KEY = 'clipbr.refresh-token';

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

function getToken(): string | null {
  return typeof window === 'undefined' ? null : localStorage.getItem(TOKEN_KEY);
}

export function storeSession(session: AuthResponse): void {
  localStorage.setItem(TOKEN_KEY, session.accessToken);
  if (session.refreshToken) localStorage.setItem(REFRESH_KEY, session.refreshToken);
  localStorage.setItem('clipbr.user', JSON.stringify(session.user));
  window.dispatchEvent(new Event('clipbr:session'));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem('clipbr.user');
  window.dispatchEvent(new Event('clipbr:session'));
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

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_URL}${path}`, { ...init, headers, cache: 'no-store' });
  const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    if (response.status === 401) clearSession();
    throw new ApiError(response.status, errorMessage(payload, response.status), payload);
  }
  return payload as T;
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
