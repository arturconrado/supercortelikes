'use client';

import { ArrowLeft, CheckCircle2, Clock3, Film, LoaderCircle, Pencil, Scissors, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipCard } from '@/components/clip-card';
import { Alert, Badge, Button, Card, EmptyState, Input, Modal, PageHeader, Progress, Skeleton, StatusBadge } from '@/components/ui';
import { useCollection, useResource } from '@/hooks/use-resource';
import { useVideoEvents, type PipelineEventSnapshot } from '@/hooks/use-video-events';
import { api } from '@/lib/api';
import type { Clip, Video } from '@/lib/types';
import { cn, formatBytes, formatDate, formatDuration } from '@/lib/utils';

const PIPELINE_STAGES = [
  { key: 'INGESTION', label: 'Importação' },
  { key: 'TRANSCRIPTION', label: 'Transcrição' },
  { key: 'SEGMENTATION', label: 'Segmentos' },
  { key: 'SCORING', label: 'Viral score' },
  { key: 'CLIPS', label: 'Cortes' },
  { key: 'CAPTIONS', label: 'Legendas' },
  { key: 'RENDERING', label: 'Render' },
  { key: 'EXPORTS', label: 'Exportação' },
] as const;

type PipelineSnapshot = {
  progress: number;
  run?: {
    currentStage?: string | null;
    stages: Array<{
      stage: string;
      status: string;
      attempts?: number;
      startedAt?: string | null;
      completedAt?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    }>;
    openDeadLetters: Array<{ id: string; queue: string; errorCode: string; errorMessage: string }>;
  } | null;
};

function effectiveStatus(video: Video): string {
  if (video.status === 'FAILED') return 'FAILED';
  return video.processingStatus ?? video.status;
}

function isProcessing(video: Video, clips: Clip[]): boolean {
  const status = effectiveStatus(video).toUpperCase();
  return !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status) || clips.length === 0;
}

function pipelineProgress(video: Video, clips: Clip[]): number {
  const status = effectiveStatus(video).toUpperCase();
  if (status === 'SUCCEEDED' || clips.length > 0) return 100;
  if (status === 'FAILED' || status === 'CANCELLED') return 100;
  const index = PIPELINE_STAGES.findIndex((stage) => stage.key === video.currentStage);
  if (index < 0) return 8;
  return Math.max(8, Math.round((index / PIPELINE_STAGES.length) * 100));
}

export default function VideoPage() {
  const { id } = useParams<{ id: string }>();
  const videoResource = useResource<Video>(`/videos/${id}`);
  const pipelineResource = useResource<PipelineSnapshot>(`/videos/${id}/pipeline`);
  const clipsResource = useCollection<Clip>(`/videos/${id}/clips`);
  const { data: video, loading, error, refresh, setData: setVideo } = videoResource;
  const { refresh: refreshClips } = clipsResource;
  const { refresh: refreshPipeline, setData: setPipeline } = pipelineResource;
  const rawClips = clipsResource.data;
  const [clipFilter, setClipFilter] = useState<'ALL' | 'HIGH_SCORE' | 'READY' | 'VERTICAL'>('ALL');
  const [clipSort, setClipSort] = useState<'SCORE' | 'DURATION' | 'RECENT'>('SCORE');
  const [retrying, setRetrying] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState('');
  const [previewClip, setPreviewClip] = useState<Clip | null>(null);
  const [lastPipelineRefreshAt, setLastPipelineRefreshAt] = useState<Date | null>(null);
  const clips = useMemo(() => {
    const filtered = rawClips.filter((clip) => {
      if (clipFilter === 'HIGH_SCORE') return (clip.score ?? 0) >= 80;
      if (clipFilter === 'READY') return ['READY', 'SUCCEEDED', 'COMPLETED'].includes((clip.status ?? '').toUpperCase());
      if (clipFilter === 'VERTICAL') return (clip.aspectRatio ?? '9:16') === '9:16';
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (clipSort === 'DURATION') return (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0);
      if (clipSort === 'RECENT') return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
      return (b.score ?? 0) - (a.score ?? 0);
    });
  }, [rawClips, clipFilter, clipSort]);

  useEffect(() => {
    if (video && !editingTitle) setTitleDraft(video.title ?? video.originalFilename);
  }, [video, editingTitle]);

  const handlePipelineEvent = useCallback((snapshot: PipelineEventSnapshot<PipelineSnapshot>) => {
    setPipeline(snapshot.pipeline);
    setLastPipelineRefreshAt(new Date(snapshot.generatedAt));
    if (snapshot.clipsCount !== rawClips.length || snapshot.readyExportsCount > 0) {
      void Promise.all([refresh(), refreshClips()]);
    }
  }, [rawClips.length, refresh, refreshClips, setPipeline]);

  const realtime = useVideoEvents<PipelineSnapshot>(id, Boolean(video && isProcessing(video, rawClips)), handlePipelineEvent);

  useEffect(() => {
    if (!video || !isProcessing(video, rawClips) || realtime.connected) return;
    const timer = window.setInterval(() => {
      void Promise.all([refresh(), refreshPipeline(), refreshClips()]).finally(() => setLastPipelineRefreshAt(new Date()));
    }, 3500);
    return () => window.clearInterval(timer);
  }, [video, rawClips, realtime.connected, refresh, refreshPipeline, refreshClips]);

  useEffect(() => {
    if (pipelineResource.data) setLastPipelineRefreshAt(new Date());
  }, [pipelineResource.data]);

  async function retryPipeline() {
    setRetrying(true);
    try {
      await api(`/videos/${id}/retry`, { method: 'POST' });
      await Promise.all([refresh(), refreshPipeline(), refreshClips()]);
    } finally {
      setRetrying(false);
    }
  }

  async function saveTitle() {
    if (!video) return;
    setSavingTitle(true);
    setTitleError('');
    try {
      const updated = await api<Video>(`/videos/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: titleDraft }),
      });
      setVideo(updated);
      setEditingTitle(false);
    } catch (reason) {
      setTitleError(reason instanceof Error ? reason.message : 'Não foi possível renomear o vídeo.');
    } finally {
      setSavingTitle(false);
    }
  }

  if (loading && !video) return <Skeleton className="h-[520px]"/>;
  if (error || !video) return <Alert>{error ?? 'Vídeo não encontrado.'}</Alert>;

  const status = effectiveStatus(video);
  const processing = isProcessing(video, rawClips);
  const pipeline = pipelineResource.data;
  const progress = pipeline?.progress ?? pipelineProgress(video, rawClips);
  const openErrors = pipeline?.run?.openDeadLetters ?? [];
  const displayTitle = video.title ?? video.originalFilename;
  const activity = pipeline?.run?.stages ?? [];
  const liveStatusText = processing
    ? realtime.connected
      ? 'Tempo real ativo: recebendo eventos do pipeline, logs e exports.'
      : realtime.error
        ? 'Tempo real indisponível; usando polling seguro a cada 3,5s.'
        : 'Conectando ao tempo real do pipeline…'
    : 'Último estado carregado.';

  return (
    <>
      <Link href="/library" className="mb-5 inline-flex items-center gap-2 text-sm text-zinc-500 hover:text-white">
        <ArrowLeft className="size-4"/>Biblioteca
      </Link>

      <PageHeader
        title={displayTitle}
        description={`Importado/enviado em ${formatDate(video.createdAt)}`}
        action={<div className="flex flex-wrap items-center gap-2"><Button variant="secondary" size="sm" onClick={() => setEditingTitle(true)}><Pencil className="size-3.5"/>Renomear</Button><StatusBadge status={status}/></div>}
      />

      {editingTitle && (
        <Card className="mb-6 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <div className="flex-1">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-600">Nome do vídeo</p>
              <Input
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                maxLength={180}
                autoFocus
                aria-label="Nome do vídeo"
              />
              <p className="mt-2 text-xs text-zinc-600">Arquivo original: {video.originalFilename}</p>
              {titleError && <p className="mt-2 text-xs text-red-300">{titleError}</p>}
            </div>
            <div className="flex gap-2">
              <Button type="button" onClick={() => void saveTitle()} disabled={savingTitle || titleDraft.trim().length < 1}>
                {savingTitle && <LoaderCircle className="size-4 animate-spin"/>}
                Salvar
              </Button>
              <Button type="button" variant="ghost" onClick={() => { setTitleDraft(displayTitle); setEditingTitle(false); setTitleError(''); }}>
                <X className="size-4"/>Cancelar
              </Button>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-[1.4fr_.6fr]">
        <Card className="overflow-hidden">
          <div className="aspect-video bg-black">
            {video.playbackUrl ? (
              <video src={video.playbackUrl} controls className="h-full w-full"/>
            ) : (
              <div className="grid h-full place-items-center">
                <Film className="size-10 text-zinc-800"/>
              </div>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-white">Processamento</h2>
              <p className="mt-1 text-xs text-zinc-600">
                {processing ? 'Estamos preparando os cortes. Esta tela atualiza automaticamente.' : 'Processamento concluído.'}
              </p>
            </div>
            {processing ? <LoaderCircle className="size-5 animate-spin text-lime"/> : <CheckCircle2 className="size-5 text-emerald-400"/>}
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between text-xs text-zinc-600">
              <span>{pipeline?.run?.currentStage ? stageLabel(pipeline.run.currentStage) : video.currentStage ? stageLabel(video.currentStage) : processing ? 'Na fila' : 'Concluído'}</span>
              <span>{progress}%</span>
            </div>
            <Progress value={progress}/>
            <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-zinc-600">
              <span>{liveStatusText}</span>
              <span>{(realtime.lastEventAt ?? lastPipelineRefreshAt) ? `Atualizado ${(realtime.lastEventAt ?? lastPipelineRefreshAt)!.toLocaleTimeString('pt-BR')}` : 'Aguardando primeiro log…'}</span>
            </div>
          </div>

          {openErrors.length > 0 && (
            <div className="mt-5 rounded-xl border border-red-500/20 bg-red-500/[.08] p-3 text-sm text-red-100">
              <p className="font-semibold">O processamento encontrou um erro.</p>
              <p className="mt-1 text-xs leading-5 text-red-200/80">{openErrors[0]?.errorMessage ?? openErrors[0]?.errorCode}</p>
              <Button size="sm" variant="secondary" className="mt-3" onClick={() => void retryPipeline()} disabled={retrying}>
                {retrying && <LoaderCircle className="size-3 animate-spin"/>}
                Tentar novamente
              </Button>
            </div>
          )}

          <div className="mt-5 grid grid-cols-2 gap-2">
            {PIPELINE_STAGES.map((stage) => {
              const onDemand = stage.key === 'RENDERING' || stage.key === 'EXPORTS';
              const currentIndex = PIPELINE_STAGES.findIndex((item) => item.key === video.currentStage);
              const stageIndex = PIPELINE_STAGES.findIndex((item) => item.key === stage.key);
              const pipelineStage = pipeline?.run?.stages.find((item) => item.stage === stage.key);
              const mainPipelineDone = rawClips.length > 0 || status === 'SUCCEEDED';
              const done = pipelineStage?.status === 'SUCCEEDED' || (!onDemand && (mainPipelineDone || (currentIndex >= 0 && stageIndex < currentIndex)));
              const failed = pipelineStage?.status === 'FAILED' || pipelineStage?.status === 'DEAD_LETTERED';
              const active = video.currentStage === stage.key && processing;
              const standby = onDemand && mainPipelineDone && !done && !failed && !active;
              return (
                <div key={stage.key} className={cn('rounded-xl border px-3 py-2 text-xs', failed ? 'border-red-500/20 bg-red-500/[.08] text-red-200' : done ? 'border-emerald-500/15 bg-emerald-500/[.06] text-emerald-200' : active ? 'border-lime/20 bg-lime/[.08] text-lime' : standby ? 'border-white/[.08] bg-white/[.035] text-zinc-400' : 'border-white/[.06] bg-white/[.025] text-zinc-600')}>
                  {stage.label}
                  {standby && <span className="ml-1 text-[10px] text-zinc-600">· sob demanda</span>}
                </div>
              );
            })}
          </div>

          <div className="mt-5 rounded-2xl border border-white/[.06] bg-black/20 p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Logs do processamento</p>
              {processing && <span className="inline-flex items-center gap-1 text-[11px] text-lime"><LoaderCircle className="size-3 animate-spin"/>ao vivo</span>}
            </div>
            <div className="space-y-2">
              {activity.length ? activity.map((item) => (
                <div key={`${item.stage}-${item.startedAt ?? item.status}`} className="flex items-start justify-between gap-3 rounded-xl bg-white/[.025] px-3 py-2 text-xs">
                  <div>
                    <p className="font-medium text-zinc-200">{stageLabel(item.stage)}</p>
                    <p className="mt-0.5 text-zinc-600">
                      {item.status}
                      {item.attempts ? ` · tentativa ${item.attempts}` : ''}
                      {item.errorMessage ? ` · ${item.errorMessage}` : ''}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] text-zinc-600">
                    {item.completedAt ? new Date(item.completedAt).toLocaleTimeString('pt-BR') : item.startedAt ? new Date(item.startedAt).toLocaleTimeString('pt-BR') : 'pendente'}
                  </span>
                </div>
              )) : (
                <div className="rounded-xl bg-white/[.025] px-3 py-2 text-xs text-zinc-500">
                  Aguardando o primeiro evento do pipeline. Esta área atualiza automaticamente enquanto o worker processa o vídeo.
                </div>
              )}
            </div>
          </div>

          <h2 className="mt-7 font-semibold text-white">Detalhes</h2>
          <dl className="mt-5 space-y-4 text-sm">
            {[
              ['Arquivo', video.originalFilename],
              ['Formato', video.container?.toUpperCase() ?? video.mimeType],
              ['Tamanho', formatBytes(video.sizeBytes)],
              ['Duração', formatDuration(video.durationSeconds)],
              ['Cortes', String(video.clipsCount ?? rawClips.length ?? 0)],
            ].map(([key, value]) => (
              <div key={key} className="flex justify-between gap-4">
                <dt className="text-zinc-600">{key}</dt>
                <dd className="truncate text-zinc-300">{value}</dd>
              </div>
            ))}
          </dl>

          {video.burnedInSubtitlesDetected && (
            <div className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/[.08] p-3 text-xs leading-5 text-amber-100">
              Detectamos possível legenda já queimada no vídeo
              {video.burnedInSubtitlesConfidence != null ? ` (${Math.round(video.burnedInSubtitlesConfidence * 100)}% de confiança)` : ''}.
              Revise o corte antes de renderizar novas legendas.
            </div>
          )}

          {video.projectId && (
            <Button asChild variant="secondary" className="mt-6 w-full">
              <Link href={`/projects/${video.projectId}`}><Scissors className="size-4"/>Abrir projeto</Link>
            </Button>
          )}
        </Card>
      </div>

      <div className="mt-8">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 className="font-semibold text-white">Cortes encontrados</h2>
            <p className="mt-1 text-xs text-zinc-600">Filtre, pré-visualize e abra o editor para ajustar cada corte.</p>
          </div>
          {processing && <span className="inline-flex items-center gap-2 text-xs text-zinc-500"><Clock3 className="size-3"/>Atualizando…</span>}
        </div>
        <div className="mb-4 grid gap-3 rounded-2xl border border-white/[.07] bg-panel/70 p-3 sm:grid-cols-2 lg:flex lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
            {[
              ['ALL', 'Todos'],
              ['HIGH_SCORE', 'Score 80+'],
              ['READY', 'Prontos'],
              ['VERTICAL', '9:16'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setClipFilter(value as typeof clipFilter)}
                className={cn('rounded-full px-3 py-1.5 text-xs font-semibold transition', clipFilter === value ? 'bg-lime text-black' : 'bg-white/[.05] text-zinc-400 hover:text-white')}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-zinc-500 lg:justify-end">
            Ordenar
            <select
              value={clipSort}
              onChange={(event) => setClipSort(event.target.value as typeof clipSort)}
              className="h-9 rounded-xl border border-white/10 bg-white/[.035] px-3 text-xs text-white outline-none"
            >
              <option value="SCORE">Maior score</option>
              <option value="DURATION">Maior duração</option>
              <option value="RECENT">Mais recentes</option>
            </select>
          </label>
        </div>

        {clipsResource.loading && !rawClips.length ? (
          <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-72"/>)}
          </div>
        ) : clips.length ? (
          <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {clips.map((clip) => <ClipCard key={clip.id} clip={clip} onPreview={setPreviewClip}/>)}
          </div>
        ) : (
          <EmptyState
            icon={processing ? Scissors : Film}
            title={processing ? 'A IA está encontrando os melhores cortes' : 'Nenhum corte foi gerado ainda'}
            description={processing ? 'Pode levar alguns minutos, principalmente em vídeos longos. Você pode deixar esta tela aberta.' : 'Se o processamento terminou sem cortes, tente reprocessar o vídeo ou envie outro conteúdo.'}
          />
        )}
      </div>

      <Modal
        open={Boolean(previewClip)}
        onClose={() => setPreviewClip(null)}
        title={previewClip?.title ?? 'Preview do corte'}
        description={previewClip ? `${formatDuration(previewClip.durationSeconds ?? 0)} · ${previewClip.aspectRatio ?? '9:16'}` : undefined}
      >
        {previewClip?.renderUrl || previewClip?.playbackUrl ? (
          <div className="overflow-hidden rounded-2xl bg-black">
            <video src={previewClip.renderUrl ?? previewClip.playbackUrl} poster={previewClip.thumbnailUrl} controls className="mx-auto max-h-[70vh] w-full object-contain">
              {previewClip.captionsUrl && <track kind="captions" src={previewClip.captionsUrl} srcLang="pt" label="Português" default/>}
            </video>
          </div>
        ) : (
          <div className="rounded-2xl border border-white/[.08] bg-white/[.03] p-5 text-sm leading-6 text-zinc-400">
            O preview em vídeo aparece após o render. Enquanto isso, use a thumbnail e acompanhe o processamento nesta tela.
          </div>
        )}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {previewClip?.status && <StatusBadge status={previewClip.status}/>}
            {previewClip?.score != null && <Badge tone="lime">Score {Math.round(previewClip.score)}</Badge>}
          </div>
          {previewClip && (
            <Button asChild size="sm">
              <Link href={`/clips/${previewClip.id}`}>Abrir editor</Link>
            </Button>
          )}
        </div>
      </Modal>
    </>
  );
}

function stageLabel(stage: string): string {
  return PIPELINE_STAGES.find((item) => item.key === stage)?.label ?? stage.replaceAll('_', ' ');
}
