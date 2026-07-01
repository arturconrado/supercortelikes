'use client';

import { Check, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useMemo, useState } from 'react';
import { Alert, Button, Input, Label } from '@/components/ui';
import { TurnstileBox } from '@/components/turnstile';
import { api, endpoints, storeSession, unwrap } from '@/lib/api';
import type { AuthResponse } from '@/lib/types';

const passwordRules = [
  { id: 'length', label: '12 caracteres ou mais', test: (value: string) => value.length >= 12 },
  { id: 'lowercase', label: 'uma letra minúscula', test: (value: string) => /[a-z]/.test(value) },
  { id: 'uppercase', label: 'uma letra maiúscula', test: (value: string) => /[A-Z]/.test(value) },
  { id: 'number', label: 'um número', test: (value: string) => /[0-9]/.test(value) },
] as const;

function passwordQuality(password: string) {
  const checks = passwordRules.map((rule) => ({ ...rule, passed: rule.test(password) }));
  const score = checks.filter((item) => item.passed).length;
  if (!password) return { checks, score, label: 'Digite uma senha', tone: 'neutral', width: '0%' };
  if (score <= 1) return { checks, score, label: 'Senha fraca', tone: 'bad', width: '25%' };
  if (score <= 3) return { checks, score, label: 'Quase lá', tone: 'warn', width: '65%' };
  return { checks, score, label: 'Senha boa', tone: 'good', width: '100%' };
}

function fieldError(form: { displayName: string; email: string; password: string }, passwordValid: boolean): string {
  if (form.displayName.trim().length < 2) return 'Informe seu nome com pelo menos 2 caracteres.';
  if (!form.email.trim()) return 'Informe seu e-mail.';
  if (!passwordValid) return 'Crie uma senha com 12+ caracteres, maiúscula, minúscula e número.';
  return '';
}

export default function RegisterPage() {
  const termsVersion = process.env.NEXT_PUBLIC_TERMS_VERSION ?? 'terms-2026-06';
  const privacyVersion = process.env.NEXT_PUBLIC_PRIVACY_VERSION ?? 'privacy-2026-06';
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '';
  const router = useRouter();
  const [form, setForm] = useState({ displayName: '', email: '', password: '' });
  const [accepted, setAccepted] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const password = useMemo(() => passwordQuality(form.password), [form.password]);
  const passwordValid = password.score === passwordRules.length;
  const nameNeedsHelp = form.displayName.length > 0 && form.displayName.trim().length < 2;
  const canSubmit = !busy && accepted && !fieldError(form, passwordValid) && (!turnstileSiteKey || Boolean(turnstileToken));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const validationError = fieldError(form, passwordValid);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!accepted) {
      setError('Aceite os termos para continuar.');
      return;
    }
    if (turnstileSiteKey && !turnstileToken) {
      setError('Confirme a proteção antiabuso para continuar.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const session = unwrap(await api<AuthResponse | { data: AuthResponse }>(endpoints.register, {
        method: 'POST',
        body: JSON.stringify({
          displayName: form.displayName.trim(),
          email: form.email.trim(),
          password: form.password,
          acceptedTermsVersion: termsVersion,
          acceptedPrivacyVersion: privacyVersion,
          ...(turnstileToken ? { turnstileToken } : {}),
        }),
      }));
      storeSession(session);
      router.replace('/dashboard');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível criar a conta.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="animate-fade-in">
      <p className="text-xs font-bold uppercase tracking-[.16em] text-lime">Comece agora</p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">Crie sua conta grátis</h1>
      <p className="mt-2 text-sm text-zinc-500">Sem cartão. Seu primeiro projeto começa aqui.</p>

      <form onSubmit={submit} className="mt-8 space-y-4" noValidate>
        {error && <Alert>{error}</Alert>}
        <div>
          <Label htmlFor="displayName">Nome</Label>
          <Input
            id="displayName"
            name="displayName"
            autoComplete="name"
            required
            minLength={2}
            maxLength={80}
            placeholder="Seu nome"
            aria-invalid={nameNeedsHelp}
            aria-describedby={nameNeedsHelp ? 'displayName-help' : undefined}
            value={form.displayName}
            onChange={(event) => setForm({ ...form, displayName: event.target.value })}
          />
          {nameNeedsHelp && <p id="displayName-help" className="mt-2 text-xs text-amber-300">Use pelo menos 2 caracteres.</p>}
        </div>
        <div>
          <Label htmlFor="email">E-mail</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            placeholder="voce@empresa.com"
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="password">Senha</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            aria-describedby="password-quality password-rules"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
          />
          <div id="password-quality" className="mt-3 rounded-xl border border-white/10 bg-white/[.03] p-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-zinc-300">Qualidade da senha</span>
              <span className={password.tone === 'good' ? 'text-emerald-300' : password.tone === 'warn' ? 'text-amber-300' : password.tone === 'bad' ? 'text-red-300' : 'text-zinc-500'}>
                {password.label}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/[.08]">
              <div
                className={`h-full rounded-full transition-all ${password.tone === 'good' ? 'bg-emerald-400' : password.tone === 'warn' ? 'bg-amber-300' : 'bg-red-400'}`}
                style={{ width: password.width }}
              />
            </div>
            <ul id="password-rules" className="mt-3 grid gap-1.5 text-xs text-zinc-500 sm:grid-cols-2">
              {password.checks.map((rule) => (
                <li key={rule.id} className={rule.passed ? 'flex items-center gap-1.5 text-emerald-300' : 'flex items-center gap-1.5'}>
                  <Check className={`size-3 ${rule.passed ? 'text-emerald-300' : 'text-zinc-700'}`} />
                  {rule.label}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <label className="flex cursor-pointer items-start gap-3 py-2 text-xs leading-5 text-zinc-500">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
            className="mt-1 accent-[#c9ff42]"
          />
          <span>
            Li e aceito os <Link href="/terms" className="text-zinc-200 underline">Termos de Uso</Link> e a{' '}
            <Link href="/privacy" className="text-zinc-200 underline">Política de Privacidade</Link>.
          </span>
        </label>
        <TurnstileBox action="register" siteKey={turnstileSiteKey} onToken={setTurnstileToken} />
        <Button className="w-full" size="lg" disabled={!canSubmit}>
          {busy && <LoaderCircle className="size-4 animate-spin" />}
          Criar conta
        </Button>
      </form>

      <p className="mt-7 text-center text-sm text-zinc-500">
        Já tem conta? <Link href="/login" className="font-semibold text-white hover:text-lime">Entrar</Link>
      </p>
    </div>
  );
}
