'use client';

import { BarChart3, Bell, CreditCard, FolderKanban, LayoutDashboard, Library, LogOut, Menu, Settings, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from './auth-provider';
import { Logo } from './logo';
import { Spinner } from './ui';
import { cn, initials } from '@/lib/utils';

const nav = [
  { href: '/dashboard', label: 'Visão geral', icon: LayoutDashboard }, { href: '/upload', label: 'Novo vídeo', icon: Upload },
  { href: '/library', label: 'Biblioteca', icon: Library }, { href: '/projects', label: 'Projetos', icon: FolderKanban },
  { href: '/exports', label: 'Exportações', icon: CreditCard }, { href: '/analytics', label: 'Analytics', icon: BarChart3 },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false); const pathname = usePathname(); const { user, loading, logout } = useAuth();
  if (loading) return <div className="grid min-h-screen place-items-center bg-canvas"><Spinner className="size-7" /></div>;
  if (!user) return null;
  const sidebar = <><div className="flex h-20 items-center justify-between px-5"><Logo /><button className="lg:hidden" onClick={() => setOpen(false)} aria-label="Fechar menu"><X className="size-5" /></button></div><nav className="flex-1 space-y-1 px-3">{nav.map(({ href, label, icon: Icon }) => { const active = pathname === href || pathname.startsWith(`${href}/`); return <Link key={href} href={href} onClick={() => setOpen(false)} className={cn('flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition', active ? 'bg-lime/[.09] text-lime' : 'text-zinc-500 hover:bg-white/[.04] hover:text-zinc-200')}><Icon className="size-[18px]" />{label}</Link>; })}</nav><div className="border-t border-white/[.06] p-3"><Link href="/billing" className="mb-1 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-zinc-500 hover:bg-white/[.04] hover:text-white"><CreditCard className="size-[18px]"/>Plano e cobrança</Link><Link href="/settings" className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-zinc-500 hover:bg-white/[.04] hover:text-white"><Settings className="size-[18px]"/>Configurações</Link><button onClick={logout} className="mt-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-zinc-500 hover:bg-white/[.04] hover:text-white"><LogOut className="size-[18px]"/>Sair</button></div></>;
  return <div className="min-h-screen bg-canvas text-zinc-200"><aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-white/[.06] bg-[#0b0c11] lg:flex">{sidebar}</aside>{open && <><button className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden" onClick={() => setOpen(false)} aria-label="Fechar menu"/><aside className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-white/10 bg-[#0b0c11] lg:hidden">{sidebar}</aside></>}<div className="lg:pl-64"><header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-white/[.06] bg-canvas/85 px-4 backdrop-blur-xl sm:px-7"><button className="rounded-lg p-2 text-zinc-400 hover:bg-white/[.05] lg:hidden" onClick={() => setOpen(true)} aria-label="Abrir menu"><Menu className="size-5" /></button><div className="hidden text-xs text-zinc-600 lg:block">Transforme ideias longas em vídeos que prendem.</div><div className="flex items-center gap-3"><button className="rounded-lg p-2 text-zinc-500 hover:bg-white/[.05] hover:text-white" aria-label="Notificações"><Bell className="size-5" /></button><div className="hidden text-right sm:block"><p className="text-xs font-semibold text-white">{user.name}</p><p className="text-[11px] text-zinc-600">{user.email}</p></div><div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-lime to-emerald-400 text-xs font-bold text-black">{initials(user.name)}</div></div></header><main className="mx-auto max-w-[1500px] px-4 py-7 sm:px-7 lg:px-9">{children}</main></div></div>;
}
