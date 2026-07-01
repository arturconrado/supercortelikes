'use client';

import { ArrowRight, Clock, Download, Film, Play, Scissors, Sparkles, Timer, Upload } from 'lucide-react';
import Link from 'next/link';
import { ActivityChart } from '@/components/activity-chart';
import { ProjectCard } from '@/components/project-card';
import { Alert, Button, Card, EmptyState, MetricCard, PageHeader, Skeleton, StatusBadge } from '@/components/ui';
import { useResource } from '@/hooks/use-resource';
import { endpoints } from '@/lib/api';
import type { DashboardSummary, Video } from '@/lib/types';
import { formatBytes, formatDate, formatDuration } from '@/lib/utils';

export default function DashboardPage() {
  const { data, loading, error, refresh } = useResource<DashboardSummary>(endpoints.dashboard);

  return (
    <>
      <PageHeader
        eyebrow="Seu workspace"
        title="Visão geral"
        description="Acompanhe seus vídeos, cortes e resultados em um só lugar."
        action={<Button asChild><Link href="/upload"><Upload className="size-4"/>Enviar vídeo</Link></Button>}
      />

      {error && (
        <div className="mb-5">
          <Alert>{error} <button className="ml-2 underline" onClick={() => void refresh()}>Tentar novamente</button></Alert>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-32"/>)
        ) : (
          <>
            <MetricCard label="Vídeos processados" value={data?.videosProcessed ?? 0} icon={Film}/>
            <MetricCard label="Cortes gerados" value={data?.clipsGenerated ?? 0} icon={Scissors}/>
            <MetricCard label="Downloads" value={data?.downloads ?? 0} icon={Download}/>
            <MetricCard label="Tempo processado" value={formatDuration((data?.processingMinutes ?? 0) * 60)} icon={Timer}/>
          </>
        )}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <Card className="p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-white">Atividade</h2>
              <p className="mt-1 text-xs text-zinc-600">Processamentos no período</p>
            </div>
            <Link href="/analytics" className="flex items-center gap-1 text-xs font-semibold text-lime">
              Ver analytics <ArrowRight className="size-3"/>
            </Link>
          </div>
          <div className="mt-5">{loading ? <Skeleton className="h-56"/> : <ActivityChart points={data?.activity}/>}</div>
        </Card>

        <Card className="relative overflow-hidden p-6">
          <div className="absolute -right-10 -top-10 size-36 rounded-full bg-lime/[.08] blur-2xl"/>
          <Sparkles className="size-7 text-lime"/>
          <h2 className="mt-5 text-xl font-bold text-white">Seu próximo viral pode estar em um vídeo.</h2>
          <p className="mt-3 text-sm leading-6 text-zinc-500">
            Envie o conteúdo. A IA encontra os melhores trechos, cria o enquadramento e prepara tudo para publicar.
          </p>
          <Button asChild className="mt-6"><Link href="/upload">Criar novos cortes <ArrowRight className="size-4"/></Link></Button>
        </Card>
      </div>

      <section className="mt-8">
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h2 className="font-semibold text-white">Vídeos recentes</h2>
            <p className="mt-1 text-xs text-zinc-600">Abra um vídeo para ver o processamento e os cortes gerados.</p>
          </div>
          <Link href="/library" className="text-xs font-semibold text-lime">Ver biblioteca</Link>
        </div>
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-64"/>)}
          </div>
        ) : data?.recentVideos?.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.recentVideos.slice(0, 3).map((video) => <VideoCard key={video.id} video={video}/>)}
          </div>
        ) : (
          <EmptyState
            icon={Film}
            title="Nenhum vídeo enviado ainda"
            description="Seu primeiro upload ou importação aparecerá aqui com status, thumbnail e número de cortes."
            action={<Button asChild size="sm"><Link href="/upload">Enviar primeiro vídeo</Link></Button>}
          />
        )}
      </section>

      <section className="mt-8">
        <div className="mb-4 flex items-end justify-between">
          <div>
            <h2 className="font-semibold text-white">Projetos recentes</h2>
            <p className="mt-1 text-xs text-zinc-600">Continue de onde parou</p>
          </div>
          <Link href="/projects" className="text-xs font-semibold text-lime">Ver todos</Link>
        </div>
        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-60"/>)}
          </div>
        ) : data?.recentProjects?.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.recentProjects.slice(0, 3).map((project) => <ProjectCard key={project.id} project={project}/>)}
          </div>
        ) : null}
      </section>
    </>
  );
}

function VideoCard({ video }: { video: Video }) {
  return (
    <Link href={`/library/${video.id}`} className="group overflow-hidden rounded-2xl border border-white/[.08] bg-panel transition hover:border-white/[.16]">
      <div className="relative aspect-video overflow-hidden bg-zinc-950">
        {video.thumbnailUrl ? (
          <img src={video.thumbnailUrl} alt="" className="h-full w-full object-cover transition group-hover:scale-105"/>
        ) : (
          <div className="grid h-full place-items-center"><Film className="size-8 text-zinc-800"/></div>
        )}
        <div className="absolute inset-0 grid place-items-center opacity-0 transition group-hover:bg-black/35 group-hover:opacity-100">
          <span className="rounded-full bg-lime p-3 text-black"><Play className="size-4 fill-current"/></span>
        </div>
        {video.durationSeconds != null && (
          <span className="absolute bottom-2 right-2 rounded-md bg-black/75 px-1.5 py-1 text-[10px] text-white">
            {formatDuration(video.durationSeconds)}
          </span>
        )}
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-sm font-semibold text-white">{video.title ?? video.originalFilename}</h3>
          <StatusBadge status={video.processingStatus ?? video.status}/>
        </div>
        <div className="mt-3 flex items-center justify-between text-xs text-zinc-600">
          <span className="flex items-center gap-1"><Clock className="size-3"/>{formatDate(video.createdAt)}</span>
          <span>{video.clipsCount ?? 0} cortes · {formatBytes(video.sizeBytes)}</span>
        </div>
      </div>
    </Link>
  );
}
