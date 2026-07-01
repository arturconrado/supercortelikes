import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, clearSession, storeSession, unwrap, unwrapList } from './api';

describe('API client', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('normalizes collections from supported envelopes', () => {
    expect(unwrapList({ items: [{ id: 1 }] })).toEqual([{ id: 1 }]);
    expect(unwrapList({ data: [{ id: 2 }] })).toEqual([{ id: 2 }]);
    expect(unwrap({ data: { id: 3 } })).toEqual({ id: 3 });
  });

  it('persists and clears authenticated sessions', () => {
    storeSession({ accessToken: 'token', refreshToken: 'refresh', user: { id: '1', name: 'Ana', email: 'ana@example.com' } });
    expect(localStorage.getItem('clipbr.access-token')).toBe('token');
    clearSession();
    expect(localStorage.getItem('clipbr.access-token')).toBeNull();
  });

  it('adds the bearer token and turns error responses into ApiError', async () => {
    localStorage.setItem('clipbr.access-token', 'secret');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ message: 'Não autorizado' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
    await expect(api('/private')).rejects.toEqual(expect.objectContaining({ status: 403, message: 'Não autorizado' }));
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer secret');
  });

  it('translates raw backend validation errors into friendly Portuguese', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      message: [
        'displayName must be longer than or equal to 2 characters',
        'displayName must be a string',
        'password must be longer than or equal to 12 characters',
      ],
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }));

    await expect(api('/auth/register')).rejects.toEqual(expect.objectContaining({
      status: 400,
      message: 'O nome precisa ter pelo menos 2 caracteres., Informe seu nome., A senha precisa ter pelo menos 12 caracteres.',
    }));
  });
});
