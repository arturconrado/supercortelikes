'use client';

import { CheckCircle2, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { Alert, Button, Input, Label } from '@/components/ui';
import { api } from '@/lib/api';

function validPassword(value: string): boolean {
  return value.length >= 12 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

export default function ResetPasswordPage() {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('token') ?? '';
    setToken(value);
    if (!value) setError('O link de redefinição está incompleto. Solicite um novo link.');
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    if (!validPassword(password)) {
      setError('Use 12 ou mais caracteres, com maiúscula, minúscula e número.');
      return;
    }
    if (password !== confirmation) {
      setError('As senhas não coincidem.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/auth/password/reset', { method: 'POST', body: JSON.stringify({ token, password }) });
      setSuccess(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'O link é inválido, expirou ou já foi utilizado.');
    } finally {
      setBusy(false);
    }
  }

  if (success) {
    return (
      <div className="animate-fade-in text-center" aria-live="polite">
        <CheckCircle2 className="mx-auto size-12 text-emerald-300" aria-hidden="true" />
        <h1 className="mt-5 text-3xl font-bold">Senha atualizada</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-500">As sessões anteriores foram encerradas. Entre novamente com sua nova senha.</p>
        <Link href="/login" className="mt-8 inline-flex rounded-xl bg-lime px-5 py-3 text-sm font-bold text-black hover:bg-[#d7ff70]">Entrar</Link>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <p className="text-xs font-bold uppercase tracking-[.16em] text-lime">Nova senha</p>
      <h1 className="mt-3 text-3xl font-bold">Proteja sua conta</h1>
      <p className="mt-2 text-sm leading-6 text-zinc-500">O link funciona uma única vez e todas as sessões anteriores serão encerradas.</p>
      <form onSubmit={submit} className="mt-8 space-y-5">
        {error && <Alert>{error}</Alert>}
        <div>
          <Label htmlFor="new-password">Nova senha</Label>
          <Input id="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby="password-rules" />
          <p id="password-rules" className="mt-2 text-xs leading-5 text-zinc-600">12+ caracteres, uma letra maiúscula, uma minúscula e um número.</p>
        </div>
        <div>
          <Label htmlFor="confirm-password">Confirmar nova senha</Label>
          <Input id="confirm-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
        </div>
        <Button className="w-full" size="lg" disabled={busy || !token}>
          {busy && <LoaderCircle className="size-4 animate-spin" />}
          Redefinir senha
        </Button>
      </form>
      <Link href="/forgot-password" className="mt-7 block text-center text-sm font-medium text-zinc-400 hover:text-lime">Solicitar outro link</Link>
    </div>
  );
}
