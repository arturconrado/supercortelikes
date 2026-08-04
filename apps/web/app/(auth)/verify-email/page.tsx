'use client';

import { CheckCircle2, LoaderCircle, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type VerificationState = 'loading' | 'success' | 'error' | 'missing';

export default function VerifyEmailPage() {
  const [state, setState] = useState<VerificationState>('loading');
  const [message, setMessage] = useState('Validando seu link de verificação…');

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      setState('missing');
      setMessage('O link de verificação está incompleto. Solicite um novo link na sua conta.');
      return;
    }
    let active = true;
    void api('/auth/email/verify', { method: 'POST', body: JSON.stringify({ token }) })
      .then(() => {
        if (!active) return;
        setState('success');
        setMessage('E-mail verificado. Sua conta está pronta para processar vídeos.');
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setState('error');
        setMessage(reason instanceof Error ? reason.message : 'Este link é inválido, expirou ou já foi utilizado.');
      });
    return () => { active = false; };
  }, []);

  return (
    <div className="animate-fade-in text-center" aria-live="polite">
      <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-white/10 bg-white/[.04]">
        {state === 'loading' && <LoaderCircle className="size-6 animate-spin text-lime" aria-hidden="true" />}
        {state === 'success' && <CheckCircle2 className="size-7 text-emerald-300" aria-hidden="true" />}
        {(state === 'error' || state === 'missing') && <XCircle className="size-7 text-red-300" aria-hidden="true" />}
      </div>
      <p className="mt-6 text-xs font-bold uppercase tracking-[.16em] text-lime">Verificação de e-mail</p>
      <h1 className="mt-3 text-3xl font-bold">{state === 'success' ? 'Tudo certo' : state === 'loading' ? 'Só um instante' : 'Não foi possível verificar'}</h1>
      <p className="mt-3 text-sm leading-6 text-zinc-500">{message}</p>
      <Link href={state === 'success' ? '/dashboard' : '/login'} className="mt-8 inline-flex rounded-xl bg-lime px-5 py-3 text-sm font-bold text-black hover:bg-[#d7ff70]">
        {state === 'success' ? 'Ir para o dashboard' : 'Voltar para o login'}
      </Link>
    </div>
  );
}
