'use client';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertCircle, Inbox, LoaderCircle, X } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime/70 disabled:pointer-events-none disabled:opacity-50',
  { variants: { variant: {
    primary: 'bg-lime text-black hover:bg-[#d7ff70] shadow-[0_8px_30px_rgba(201,255,66,.12)]',
    secondary: 'border border-white/10 bg-white/[.045] text-white hover:border-white/20 hover:bg-white/[.08]',
    ghost: 'text-zinc-400 hover:bg-white/[.06] hover:text-white',
    danger: 'border border-red-500/20 bg-red-500/10 text-red-300 hover:bg-red-500/20',
  }, size: { sm: 'h-8 rounded-lg px-3 text-xs', md: 'h-10 px-4', lg: 'h-12 px-5' } }, defaultVariants: { variant: 'primary', size: 'md' } }
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> { asChild?: boolean }
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, ...props }, ref) => {
  const Component = asChild ? Slot : 'button';
  return <Component ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
Button.displayName = 'Button';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn('h-11 w-full rounded-xl border border-white/10 bg-white/[.035] px-3.5 text-sm text-white outline-none transition placeholder:text-zinc-600 focus:border-lime/50 focus:ring-2 focus:ring-lime/10 disabled:opacity-60', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn('min-h-28 w-full resize-y rounded-xl border border-white/10 bg-white/[.035] p-3.5 text-sm text-white outline-none transition placeholder:text-zinc-600 focus:border-lime/50 focus:ring-2 focus:ring-lime/10', className)} {...props} />
));
Textarea.displayName = 'Textarea';

export function Label(props: React.LabelHTMLAttributes<HTMLLabelElement>) { return <label {...props} className={cn('mb-2 block text-sm font-medium text-zinc-300', props.className)} />; }
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div className={cn('rounded-2xl border border-white/[.08] bg-panel/80 shadow-[0_20px_50px_rgba(0,0,0,.14)]', className)} {...props} />; }
export function Badge({ children, tone = 'neutral', className }: { children: React.ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'lime'; className?: string }) {
  const tones = { neutral: 'bg-white/[.07] text-zinc-300', good: 'bg-emerald-500/10 text-emerald-300', warn: 'bg-amber-500/10 text-amber-300', bad: 'bg-red-500/10 text-red-300', lime: 'bg-lime/10 text-lime' };
  return <span className={cn('inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none', tones[tone], className)}>{children}</span>;
}
export function StatusBadge({ status }: { status?: string }) {
  const value = (status || 'PENDING').toUpperCase();
  const tone = ['COMPLETED', 'SUCCEEDED', 'READY', 'ACTIVE', 'UPLOADED'].includes(value) ? 'good' : ['FAILED', 'CANCELLED', 'EXPIRED'].includes(value) ? 'bad' : ['PROCESSING', 'RUNNING', 'RENDERING'].includes(value) ? 'lime' : 'warn';
  const labels: Record<string, string> = { COMPLETED: 'Concluído', SUCCEEDED: 'Concluído', READY: 'Pronto', ACTIVE: 'Ativo', UPLOADED: 'Enviado', FAILED: 'Falhou', CANCELLED: 'Cancelado', PROCESSING: 'Processando', RUNNING: 'Processando', RENDERING: 'Renderizando', PENDING: 'Na fila', UPLOADING: 'Enviando' };
  return <Badge tone={tone}>{labels[value] ?? value.replaceAll('_', ' ')}</Badge>;
}
export function Progress({ value, className }: { value: number; className?: string }) { return <div className={cn('h-2 overflow-hidden rounded-full bg-white/[.07]', className)}><div className="h-full rounded-full bg-lime transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>; }
export function Spinner({ className }: { className?: string }) { return <LoaderCircle className={cn('size-5 animate-spin text-lime', className)} aria-label="Carregando" />; }
export function Alert({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) { return <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-500/15 bg-red-500/[.08] p-3.5 text-sm text-red-200"><AlertCircle className="mt-0.5 size-4 shrink-0"/><div className="flex-1">{children}</div>{onClose && <button onClick={onClose} aria-label="Fechar"><X className="size-4" /></button>}</div>; }
export function EmptyState({ icon: Icon = Inbox, title, description, action }: { icon?: React.ComponentType<{ className?: string }>; title: string; description: string; action?: React.ReactNode }) { return <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 px-6 py-12 text-center"><div className="mb-4 rounded-2xl bg-white/[.05] p-4"><Icon className="size-6 text-zinc-400" /></div><h3 className="font-semibold text-white">{title}</h3><p className="mt-2 max-w-sm text-sm leading-6 text-zinc-500">{description}</p>{action && <div className="mt-5">{action}</div>}</div>; }
export function Skeleton({ className }: { className?: string }) { return <div className={cn('animate-pulse rounded-xl bg-white/[.06]', className)} />; }
export function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) { return <div className="mb-7 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div>{eyebrow && <p className="mb-2 text-xs font-bold uppercase tracking-[.18em] text-lime">{eyebrow}</p>}<h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">{title}</h1>{description && <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">{description}</p>}</div>{action}</div>; }
export function MetricCard({ label, value, detail, icon: Icon }: { label: string; value: string | number; detail?: string; icon: React.ComponentType<{ className?: string }> }) { return <Card className="p-5"><div className="flex items-start justify-between"><div><p className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</p><p className="mt-3 text-2xl font-bold tracking-tight text-white">{value}</p>{detail && <p className="mt-1 text-xs text-zinc-500">{detail}</p>}</div><div className="rounded-xl bg-lime/[.08] p-2.5"><Icon className="size-5 text-lime" /></div></div></Card>; }
export function Modal({ open, onClose, title, description, children }: { open: boolean; onClose: () => void; title: string; description?: string; children: React.ReactNode }) { if (!open) return null; return <div className="fixed inset-0 z-[70] grid place-items-center p-4"><button className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} aria-label="Fechar janela"/><div role="dialog" aria-modal="true" aria-labelledby="modal-title" className="relative w-full max-w-lg animate-fade-in rounded-2xl border border-white/10 bg-[#111319] p-6 shadow-2xl"><button onClick={onClose} className="absolute right-4 top-4 rounded-lg p-1.5 text-zinc-500 hover:bg-white/[.06] hover:text-white" aria-label="Fechar"><X className="size-4"/></button><h2 id="modal-title" className="text-xl font-bold text-white">{title}</h2>{description && <p className="mt-2 text-sm leading-6 text-zinc-500">{description}</p>}<div className="mt-6">{children}</div></div></div>; }
