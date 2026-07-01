'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { Alert, Button, Input, Label } from '@/components/ui';
import { TurnstileBox } from '@/components/turnstile';
import { api } from '@/lib/api';

export default function ForgotPasswordPage() {
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '';
  const [email, setEmail] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (turnstileSiteKey && !turnstileToken) {
      setError('Confirme a proteção antiabuso para continuar.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/auth/password/forgot', {
        method: 'POST',
        body: JSON.stringify({ email, ...(turnstileToken ? { turnstileToken } : {}) }),
      });
      setSent(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível enviar o e-mail.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="animate-fade-in">
      <p className="text-xs font-bold uppercase tracking-[.16em] text-lime">Recuperação</p>
      <h1 className="mt-3 text-3xl font-bold">Redefina sua senha</h1>
      <p className="mt-2 text-sm leading-6 text-zinc-500">Enviaremos um link seguro para o seu e-mail.</p>
      {sent ? (
        <div className="mt-8 rounded-2xl border border-emerald-500/15 bg-emerald-500/[.07] p-5 text-sm leading-6 text-emerald-200">
          Se existir uma conta com esse e-mail, o link de recuperação chegará em alguns minutos.
        </div>
      ) : (
        <form onSubmit={submit} className="mt-8 space-y-5">
          {error && <Alert>{error}</Alert>}
          <div>
            <Label htmlFor="email">E-mail</Label>
            <Input id="email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <TurnstileBox action="password_forgot" siteKey={turnstileSiteKey} onToken={setTurnstileToken} />
          <Button className="w-full" size="lg" disabled={busy || Boolean(turnstileSiteKey && !turnstileToken)}>
            Enviar link
          </Button>
        </form>
      )}
      <Link href="/login" className="mt-7 block text-center text-sm font-medium text-zinc-400 hover:text-lime">
        Voltar para o login
      </Link>
    </div>
  );
}
