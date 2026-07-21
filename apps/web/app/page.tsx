import { ArrowRight, CheckCircle2, Film, Link2, Play, Scissors, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui';

const benefits = [
  ['Importe em segundos', 'Cole um link público ou envie arquivos grandes direto para o storage privado.'],
  ['IA encontra os melhores cortes', 'Transcrição, score viral, títulos, hashtags e legendas em um fluxo guiado.'],
  ['Exporte para cada canal', 'Renderize em 9:16, 1:1, 4:5 ou 16:9 com H.264 e qualidade de até 1080p.'],
];

const steps = [
  ['01', 'Envie ou cole o link'],
  ['02', 'Acompanhe o processamento'],
  ['03', 'Revise os cortes e exporte'],
];

const plans = [
  ['FREE', 'Comece grátis e exporte sem marca d’água', 'R$ 0'],
  ['PRO', 'Mais minutos e prioridade de processamento', 'BRL/mês'],
  ['BUSINESS', 'Prioridade maior para equipes e volume', 'Sob consulta'],
];

export default function Home() {
  return (
    <main className="min-h-screen overflow-hidden bg-canvas text-zinc-100">
      <div className="pointer-events-none fixed inset-0 grid-glow opacity-70"/>
      <section className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between gap-4 rounded-3xl border border-white/[.07] bg-white/[.035] px-4 py-3 backdrop-blur-xl">
          <Link href="/" className="flex items-center gap-3" aria-label="PicaShorts início">
            <span className="grid size-10 place-items-center rounded-2xl bg-lime text-black shadow-glow">
              <Scissors className="size-5"/>
            </span>
            <span className="text-lg font-black tracking-tight text-white">Pica<span className="text-lime">Shorts</span></span>
          </Link>
          <nav className="hidden items-center gap-6 text-sm text-zinc-400 md:flex">
            <a href="#como-funciona" className="hover:text-white">Como funciona</a>
            <a href="#planos" className="hover:text-white">Planos</a>
            <Link href="/login" className="hover:text-white">Entrar</Link>
          </nav>
          <Button asChild size="sm">
            <Link href="/register">Começar <ArrowRight className="size-4"/></Link>
          </Button>
        </header>

        <div className="grid flex-1 items-center gap-10 py-12 lg:grid-cols-[1.04fr_.96fr] lg:py-16">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-lime/20 bg-lime/[.08] px-3 py-1.5 text-xs font-semibold text-lime">
              <Sparkles className="size-3.5"/>
              Web mobile-first para transformar vídeos longos em cortes
            </div>
            <h1 className="mt-6 max-w-4xl text-balance text-5xl font-black leading-[.95] tracking-[-0.05em] text-white sm:text-6xl lg:text-7xl">
              Corte vídeos longos em shorts prontos para postar.
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-8 text-zinc-400 sm:text-lg">
              O PicaShorts importa seu conteúdo, acompanha o processamento em tempo real, encontra os melhores momentos e gera exports verticais com legendas.
            </p>

            <div className="mt-8 rounded-3xl border border-white/[.08] bg-[#101218]/80 p-3 shadow-2xl backdrop-blur-xl sm:p-4">
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="relative flex-1">
                  <Link2 className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-zinc-600"/>
                  <input
                    readOnly
                    value="https://youtube.com/watch?v=..."
                    aria-label="Exemplo de URL para importar"
                    className="h-14 w-full rounded-2xl border border-white/[.08] bg-black/35 pl-12 pr-4 text-sm text-zinc-500 outline-none"
                  />
                </div>
                <Button asChild className="h-14 justify-center rounded-2xl px-6">
                  <Link href="/upload">Importar vídeo</Link>
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                <span className="rounded-full bg-white/[.05] px-2.5 py-1">MP4/MOV/WEBM</span>
                <span className="rounded-full bg-white/[.05] px-2.5 py-1">Links públicos best effort</span>
                <span className="rounded-full bg-white/[.05] px-2.5 py-1">Até 5 GB</span>
              </div>
            </div>

            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg">
                <Link href="/register">Criar conta grátis <ArrowRight className="size-4"/></Link>
              </Button>
              <Button asChild size="lg" variant="secondary">
                <Link href="/login">Já tenho conta</Link>
              </Button>
            </div>
          </div>

          <div className="relative mx-auto w-full max-w-md lg:max-w-lg">
            <div className="absolute -inset-8 rounded-[3rem] bg-lime/10 blur-3xl"/>
            <div className="relative rounded-[2rem] border border-white/[.09] bg-[#101218] p-3 shadow-2xl">
              <div className="overflow-hidden rounded-[1.5rem] border border-white/[.06] bg-black">
                <div className="aspect-[9/16] bg-[radial-gradient(circle_at_50%_20%,rgba(201,255,66,.24),transparent_32%),linear-gradient(180deg,#181b22,#050507)] p-4">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span className="rounded-full bg-lime px-2 py-1 font-bold text-black">Score 91</span>
                    <span>9:16 · 00:30</span>
                  </div>
                  <div className="grid h-full place-items-center">
                    <div className="grid size-16 place-items-center rounded-full bg-white text-black shadow-glow">
                      <Play className="ml-1 size-6 fill-current"/>
                    </div>
                  </div>
                  <div className="-mt-24 rounded-2xl bg-black/65 p-4 text-center backdrop-blur">
                    <p className="text-xl font-black uppercase leading-tight text-white">Você está perdendo tempo editando manualmente</p>
                    <p className="mt-2 text-sm font-bold text-lime">#shorts #ia #conteudo</p>
                  </div>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px] text-zinc-400">
                {steps.map(([number, label]) => (
                  <div key={number} className="rounded-2xl border border-white/[.06] bg-white/[.035] p-3">
                    <p className="font-black text-lime">{number}</p>
                    <p className="mt-1">{label}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="como-funciona" className="relative border-t border-white/[.06] bg-[#0b0c11] px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-2xl">
            <p className="text-xs font-bold uppercase tracking-[.18em] text-lime">Fluxo completo</p>
            <h2 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-4xl">Do vídeo bruto ao corte pronto, sem caixa preta.</h2>
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {benefits.map(([title, description], index) => (
              <div key={title} className="rounded-3xl border border-white/[.07] bg-white/[.035] p-6">
                <div className="grid size-12 place-items-center rounded-2xl bg-lime/[.09] text-lime">
                  {[Film, Zap, ShieldCheck][index] && (() => {
                    const Icon = [Film, Zap, ShieldCheck][index]!;
                    return <Icon className="size-5"/>;
                  })()}
                </div>
                <h3 className="mt-5 font-bold text-white">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-zinc-500">{description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="planos" className="relative px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div>
              <p className="text-xs font-bold uppercase tracking-[.18em] text-lime">Planos</p>
              <h2 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-4xl">Comece simples e escale quando precisar.</h2>
            </div>
            <Button asChild variant="secondary">
              <Link href="/billing">Ver plano atual</Link>
            </Button>
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {plans.map(([name, description, price]) => (
              <div key={name} className="rounded-3xl border border-white/[.08] bg-panel p-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-black text-white">{name}</h3>
                  <CheckCircle2 className="size-5 text-lime"/>
                </div>
                <p className="mt-4 text-2xl font-black text-white">{price}</p>
                <p className="mt-3 text-sm leading-6 text-zinc-500">{description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="relative border-t border-white/[.06] px-4 py-8 text-sm text-zinc-500 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 PicaShorts. Conteúdo processado em storage privado com URLs assinadas.</p>
          <div className="flex gap-4">
            <Link href="/terms" className="hover:text-white">Termos</Link>
            <Link href="/privacy" className="hover:text-white">Privacidade</Link>
            <Link href="/refunds" className="hover:text-white">Reembolso</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
