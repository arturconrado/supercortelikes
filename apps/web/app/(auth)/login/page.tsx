'use client';

import { Eye, EyeOff, LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { Alert, Button, Input, Label } from '@/components/ui';
import { api, endpoints, storeSession, unwrap } from '@/lib/api';
import type { AuthResponse } from '@/lib/types';

export default function LoginPage() {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [visible, setVisible] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(''); try { const session = unwrap(await api<AuthResponse | { data: AuthResponse }>(endpoints.login, { method: 'POST', body: JSON.stringify({ email, password }) })); storeSession(session); const next = new URLSearchParams(window.location.search).get('next'); router.replace(next || '/dashboard'); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Não foi possível entrar.'); } finally { setBusy(false); } }
  return <div className="animate-fade-in"><p className="text-xs font-bold uppercase tracking-[.16em] text-lime">Bem-vindo de volta</p><h1 className="mt-3 text-3xl font-bold tracking-tight">Entre na sua conta</h1><p className="mt-2 text-sm text-zinc-500">Seus próximos cortes estão a poucos cliques.</p><form onSubmit={submit} className="mt-8 space-y-5">{error && <Alert onClose={() => setError('')}>{error}</Alert>}<div><Label htmlFor="email">E-mail</Label><Input id="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="voce@empresa.com" /></div><div><div className="flex justify-between"><Label htmlFor="password">Senha</Label><Link href="/forgot-password" className="text-xs font-medium text-zinc-500 hover:text-lime">Esqueci minha senha</Link></div><div className="relative"><Input id="password" type={visible ? 'text' : 'password'} autoComplete="current-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} className="pr-11"/><button type="button" onClick={() => setVisible(!visible)} className="absolute right-3 top-3 text-zinc-500 hover:text-white" aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'}>{visible ? <EyeOff className="size-5"/> : <Eye className="size-5"/>}</button></div></div><Button className="w-full" size="lg" disabled={busy}>{busy && <LoaderCircle className="size-4 animate-spin"/>}Entrar</Button></form><p className="mt-7 text-center text-sm text-zinc-500">Ainda não tem conta? <Link href="/register" className="font-semibold text-white hover:text-lime">Crie grátis</Link></p></div>;
}
