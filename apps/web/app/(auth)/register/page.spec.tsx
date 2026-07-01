import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RegisterPage from './page';

const replace = vi.fn();
const apiMock = vi.fn();
const storeSessionMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
}));

vi.mock('@/lib/api', () => ({
  api: (...args: unknown[]) => apiMock(...args),
  endpoints: { register: '/auth/register' },
  storeSession: (...args: unknown[]) => storeSessionMock(...args),
  unwrap: (payload: unknown) => payload && typeof payload === 'object' && 'data' in payload
    ? (payload as { data: unknown }).data
    : payload,
}));

describe('RegisterPage', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.mockResolvedValue({
      accessToken: 'access',
      refreshToken: 'refresh',
      user: { id: 'user-1', name: 'Ana Demo', email: 'ana@example.com' },
    });
  });

  it('sends the canonical displayName contract and current password policy', async () => {
    render(<RegisterPage />);

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Ana Demo' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'ana@example.com' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'Password12345' } });
    fireEvent.click(screen.getByLabelText(/Li e aceito/));
    fireEvent.click(screen.getByRole('button', { name: /Criar conta/ }));

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/auth/register', expect.objectContaining({ method: 'POST' })));

    const [, request] = apiMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(request.body)).toEqual({
      displayName: 'Ana Demo',
      email: 'ana@example.com',
      password: 'Password12345',
      acceptedTermsVersion: 'terms-2026-06',
      acceptedPrivacyVersion: 'privacy-2026-06',
    });
    expect(screen.getByText('Senha boa')).toBeInTheDocument();
    expect(screen.getByText('12 caracteres ou mais')).toBeInTheDocument();
    expect(storeSessionMock).toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith('/dashboard');
  });

  it('guides the user before submitting invalid account data', async () => {
    render(<RegisterPage />);

    expect(screen.getByText('Qualidade da senha')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Criar conta/ })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'ana@example.com' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: '123' } });
    fireEvent.click(screen.getByLabelText(/Li e aceito/));

    expect(screen.getByText('Use pelo menos 2 caracteres.')).toBeInTheDocument();
    expect(screen.getByText('Senha fraca')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Criar conta/ })).toBeDisabled();
    expect(apiMock).not.toHaveBeenCalled();
  });
});
