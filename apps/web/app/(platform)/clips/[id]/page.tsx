'use client';

import {
  ArrowLeft,
  Check,
  Clock3,
  Download,
  LoaderCircle,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  Subtitles,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Input, Label, PageHeader, Skeleton, StatusBadge, Textarea } from '@/components/ui';
import { useResource } from '@/hooks/use-resource';
import { api } from '@/lib/api';
import type { Clip } from '@/lib/types';
import { cn, formatDuration } from '@/lib/utils';

const ASPECT_RATIOS = ['9:16', '1:1', '4:5', '16:9'] as const;
const CAPTION_TEMPLATES = ['podcast', 'business', 'finance', 'marketing', 'motivational'] as const;
type EditorTab = 'preview' | 'format' | 'captions' | 'seo' | 'export';
const EDITOR_TABS: Array<{ id: EditorTab; label: string }> = [
  { id: 'preview', label: 'Preview' },
  { id: 'format', label: 'Formato' },
  { id: 'captions', label: 'Legendas' },
  { id: 'seo', label: 'SEO' },
  { id: 'export', label: 'Exportar' },
];

export default function ClipViewerPage() {
  const { id } = useParams<{ id: string }>();
  const { data: clip, loading, error, setData } = useResource<Clip>(`/clips/${id}`);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [startSeconds, setStartSeconds] = useState('0');
  const [endSeconds, setEndSeconds] = useState('0');
  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [captionTemplate, setCaptionTemplate] = useState('podcast');
  const [captionPrimaryColor, setCaptionPrimaryColor] = useState('#ffffff');
  const [captionHighlightColor, setCaptionHighlightColor] = useState('#c6ff3a');
  const [captionFontSize, setCaptionFontSize] = useState('42');
  const [captionPosition, setCaptionPosition] = useState('bottom');
  const [captionBackground, setCaptionBackground] = useState(true);
  const [activeTab, setActiveTab] = useState<EditorTab>('preview');
  const [saving, setSaving] = useState(false);
  const [savingTiming, setSavingTiming] = useState(false);
  const [savingCaptions, setSavingCaptions] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportRequested, setExportRequested] = useState(false);
  const [message, setMessage] = useState('');

  const caption = clip?.captions?.[0];
  const captionCues = useMemo(() => caption?.cues ?? [], [caption?.cues]);

  useEffect(() => {
    if (!clip) return;
    setTitle(clip.title);
    setDescription(clip.description ?? '');
    setHashtags((clip.hashtags ?? []).join(' '));
    setStartSeconds(String(roundSeconds(clip.startSeconds ?? 0)));
    setEndSeconds(String(roundSeconds(clip.endSeconds ?? 0)));
    setAspectRatio(clip.aspectRatio ?? '9:16');
    setCaptionTemplate(caption?.template ?? 'podcast');
    const style = caption?.style ?? {};
    setCaptionPrimaryColor(typeof style.primaryColor === 'string' ? style.primaryColor : '#ffffff');
    setCaptionHighlightColor(typeof style.highlightColor === 'string' ? style.highlightColor : '#c6ff3a');
    setCaptionFontSize(typeof style.fontSize === 'number' ? String(style.fontSize) : typeof style.fontSize === 'string' ? style.fontSize : '42');
    setCaptionPosition(typeof style.position === 'string' ? style.position : 'bottom');
    setCaptionBackground(typeof style.background === 'boolean' ? style.background : true);
  }, [clip, caption?.style, caption?.template]);

  useEffect(() => {
    if (!exportRequested) return;
    if (clip?.downloadUrl) {
      setExportRequested(false);
      setMessage('Exportação pronta. Você já pode baixar o MP4.');
      return;
    }
    const timer = window.setInterval(async () => {
      try {
        const updated = await api<Clip>(`/clips/${id}`);
        setData(updated);
        if (updated.downloadUrl) {
          setExportRequested(false);
          setMessage('Exportação pronta. Você já pode baixar o MP4.');
        }
      } catch {
        // Keep the current UI state; the next poll or a manual refresh can recover.
      }
    }, 3500);
    return () => window.clearInterval(timer);
  }, [clip?.downloadUrl, exportRequested, id, setData]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      const updated = await api<Clip>(`/clips/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title,
          description,
          hashtags: hashtags.split(/\s+/).filter(Boolean),
        }),
      });
      setData(updated);
      setMessage('Conteúdo e SEO salvos.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

  async function saveTimingAndFormat() {
    setSavingTiming(true);
    setMessage('');
    try {
      const start = Number(startSeconds);
      const end = Number(endSeconds);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new Error('Informe um início e fim válidos para o corte.');
      }
      let updated = await api<Clip>(`/clips/${id}/timing`, {
        method: 'PATCH',
        body: JSON.stringify({ startSeconds: start, endSeconds: end }),
      });
      if (aspectRatio !== updated.aspectRatio) {
        updated = await api<Clip>(`/clips/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ aspectRatio }),
        });
      }
      setData(updated);
      setMessage('Timing e formato salvos. Renderize novamente para aplicar.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Não foi possível salvar timing/formato.');
    } finally {
      setSavingTiming(false);
    }
  }

  async function saveCaptions() {
    setSavingCaptions(true);
    setMessage('');
    try {
      const updated = await api<Clip>(`/clips/${id}/captions`, {
        method: 'PATCH',
        body: JSON.stringify({
          cues: captionCues,
          language: caption?.language ?? 'pt',
          template: captionTemplate,
          style: {
            primaryColor: captionPrimaryColor,
            highlightColor: captionHighlightColor,
            fontSize: Number(captionFontSize),
            position: captionPosition,
            background: captionBackground,
          },
        }),
      });
      setData(updated);
      setMessage('Estilo de legenda salvo. Renderize novamente para aplicar.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Não foi possível salvar as legendas.');
    } finally {
      setSavingCaptions(false);
    }
  }

  async function createExport() {
    setExporting(true);
    setExportRequested(false);
    setMessage('');
    try {
      await api(`/clips/${id}/export`, {
        method: 'POST',
        body: JSON.stringify({ format: 'MP4', aspectRatio: aspectRatio ?? clip?.aspectRatio ?? '9:16' }),
      });
      const updated = await api<Clip>(`/clips/${id}`);
      setData(updated);
      setExportRequested(!updated.downloadUrl);
      setMessage(updated.downloadUrl ? 'Exportação pronta. Você já pode baixar o MP4.' : 'Exportação em processamento. Esta tela será atualizada automaticamente.');
      setActiveTab('export');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Não foi possível exportar.');
    } finally {
      setExporting(false);
    }
  }

  if (loading) return <Skeleton className="h-[680px]"/>;
  if (error || !clip) return <Alert>{error ?? 'Corte não encontrado.'}</Alert>;

  const duration = clip.durationSeconds ?? ((clip.endSeconds ?? 0) - (clip.startSeconds ?? 0));
  const source = clip.renderUrl ?? clip.playbackUrl;
  const sampleCaption = extractCaptionSample(captionCues);
  const captionSize = Math.max(18, Math.min(72, Number(captionFontSize) || 42));

  return (
    <>
      <Link href={clip.videoId ? `/library/${clip.videoId}` : '/library'} className="mb-5 inline-flex items-center gap-2 text-sm text-zinc-500 hover:text-white">
        <ArrowLeft className="size-4"/>
        Voltar ao vídeo
      </Link>

      <PageHeader
        title={clip.title}
        description={`${formatDuration(duration)} · ${clip.aspectRatio ?? '9:16'} · trecho ${formatDuration(clip.startSeconds)}–${formatDuration(clip.endSeconds)}`}
        action={
          <div className="hidden flex-wrap gap-2 sm:flex">
            {clip.downloadUrl && (
              <Button asChild variant="secondary">
                <a href={clip.downloadUrl} download={clipDownloadFilename(clip)}>
                  <Download className="size-4"/>
                  Baixar
                </a>
              </Button>
            )}
            <Button onClick={() => void createExport()} disabled={exporting}>
              {exporting ? <LoaderCircle className="size-4 animate-spin"/> : <Sparkles className="size-4"/>}
              Exportar
            </Button>
          </div>
        }
      />

      {message && <div className="mb-5 rounded-xl border border-white/10 bg-white/[.04] p-3 text-sm text-zinc-300">{message}</div>}

      <div className="sticky top-16 z-20 mb-5 -mx-4 border-y border-white/[.06] bg-canvas/95 px-4 py-2 backdrop-blur-xl sm:-mx-7 sm:px-7 lg:hidden">
        <div className="flex gap-2 overflow-x-auto">
          {EDITOR_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn('shrink-0 rounded-full px-3 py-2 text-xs font-bold transition', activeTab === tab.id ? 'bg-lime text-black' : 'bg-white/[.06] text-zinc-400')}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(360px,.78fr)_1.22fr]">
        <Card className={cn('overflow-hidden bg-black', activeTab !== 'preview' && 'hidden lg:block')}>
          <div className="relative mx-auto aspect-[9/16] max-h-[680px] bg-black">
            {source ? (
              <video src={source} poster={clip.thumbnailUrl} controls className="h-full w-full object-contain">
                {clip.captionsUrl && <track kind="captions" src={clip.captionsUrl} srcLang="pt" label="Português" default/>}
              </video>
            ) : (
              <div className="grid h-full place-items-center text-center">
                <div>
                  <Play className="mx-auto size-10 text-zinc-700"/>
                  <p className="mt-3 text-sm text-zinc-600">O preview em vídeo estará disponível após o render.</p>
                </div>
              </div>
            )}
            <div className={cn('pointer-events-none absolute inset-x-5 flex justify-center', captionPosition === 'top' ? 'top-8' : captionPosition === 'middle' ? 'top-1/2 -translate-y-1/2' : 'bottom-10')}>
              <div
                className={cn('max-w-[92%] rounded-xl px-3 py-2 text-center font-black uppercase leading-tight shadow-2xl', captionBackground && 'bg-black/70 backdrop-blur')}
                style={{ color: captionPrimaryColor, fontSize: `${captionSize}px` }}
              >
                {sampleCaption}
              </div>
            </div>
          </div>
        </Card>

        <div className={cn('space-y-5', activeTab === 'preview' && 'hidden lg:block')}>
          <Card className={cn('p-5', activeTab !== 'format' && 'hidden lg:block')}>
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-white">Por que este corte?</h2>
              <StatusBadge status={clip.status}/>
            </div>
            {clip.hook && <p className="mt-4 rounded-xl border border-lime/10 bg-lime/[.05] p-3 text-sm font-medium leading-6 text-lime">Gancho: {clip.hook}</p>}
            <p className="mt-4 text-sm leading-6 text-zinc-400">{clip.reason ?? 'A análise de retenção será exibida assim que a curadoria for concluída.'}</p>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Badge tone="lime"><Zap className="mr-1 size-3 fill-current"/>Viral score {Math.round(clip.score ?? 0)}/100</Badge>
              {clip.genre && <Badge>{clip.genre}</Badge>}
            </div>
          </Card>

          <Card className={cn('p-5', activeTab !== 'format' && 'hidden lg:block')}>
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="size-4 text-lime"/>
              <h2 className="font-semibold text-white">Timing e formato</h2>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="clip-start">Início (s)</Label>
                <Input id="clip-start" type="number" min={0} step={0.1} value={startSeconds} onChange={(event) => setStartSeconds(event.target.value)}/>
              </div>
              <div>
                <Label htmlFor="clip-end">Fim (s)</Label>
                <Input id="clip-end" type="number" min={0.1} step={0.1} value={endSeconds} onChange={(event) => setEndSeconds(event.target.value)}/>
              </div>
              <div>
                <Label htmlFor="clip-aspect">Formato</Label>
                <select
                  id="clip-aspect"
                  value={aspectRatio}
                  onChange={(event) => setAspectRatio(event.target.value)}
                  className="h-11 w-full rounded-xl border border-white/10 bg-panel px-3 text-sm text-zinc-200 outline-none"
                >
                  {ASPECT_RATIOS.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-center gap-1 text-xs text-zinc-600"><Clock3 className="size-3"/>Duração atual: {formatDuration(duration)}</p>
              <Button type="button" size="sm" onClick={() => void saveTimingAndFormat()} disabled={savingTiming}>
                {savingTiming ? <LoaderCircle className="size-4 animate-spin"/> : <Check className="size-4"/>}
                Salvar timing
              </Button>
            </div>
          </Card>

          <Card className={cn('p-5', activeTab !== 'captions' && 'hidden lg:block')}>
            <div className="flex items-center gap-2">
              <Subtitles className="size-4 text-lime"/>
              <h2 className="font-semibold text-white">Legendas</h2>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="caption-template">Estilo</Label>
                <select
                  id="caption-template"
                  value={captionTemplate}
                  onChange={(event) => setCaptionTemplate(event.target.value)}
                  className="h-11 w-full rounded-xl border border-white/10 bg-panel px-3 text-sm text-zinc-200 outline-none"
                >
                  {CAPTION_TEMPLATES.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
              <div>
                <Label htmlFor="caption-primary">Cor principal</Label>
                <Input id="caption-primary" type="color" value={captionPrimaryColor} onChange={(event) => setCaptionPrimaryColor(event.target.value)}/>
              </div>
              <div>
                <Label htmlFor="caption-highlight">Cor destaque</Label>
                <Input id="caption-highlight" type="color" value={captionHighlightColor} onChange={(event) => setCaptionHighlightColor(event.target.value)}/>
              </div>
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="caption-size">Tamanho</Label>
                <Input id="caption-size" type="number" min={18} max={72} value={captionFontSize} onChange={(event) => setCaptionFontSize(event.target.value)}/>
              </div>
              <div>
                <Label htmlFor="caption-position">Posição</Label>
                <select
                  id="caption-position"
                  value={captionPosition}
                  onChange={(event) => setCaptionPosition(event.target.value)}
                  className="h-11 w-full rounded-xl border border-white/10 bg-panel px-3 text-sm text-zinc-200 outline-none"
                >
                  <option value="top">Topo</option>
                  <option value="middle">Centro</option>
                  <option value="bottom">Base</option>
                </select>
              </div>
              <label className="flex items-center gap-3 pt-7 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={captionBackground}
                  onChange={(event) => setCaptionBackground(event.target.checked)}
                  className="size-4 accent-[#c9ff42]"
                />
                Fundo escuro
              </label>
            </div>
            <div className="mt-4 rounded-xl border border-white/[.06] bg-black p-4">
              <p className="text-xs text-zinc-600">Prévia da legenda</p>
              <div className="mt-3 flex min-h-24 items-end justify-center rounded-xl bg-gradient-to-br from-zinc-800 to-zinc-950 p-4">
                <span
                  className={cn('rounded-lg px-3 py-2 text-center font-black uppercase leading-tight', captionBackground && 'bg-black/70')}
                  style={{ color: captionPrimaryColor, fontSize: `${captionSize / 2}px` }}
                >
                  {sampleCaption}
                </span>
              </div>
            </div>
            <div className="mt-4 rounded-xl border border-white/[.06] bg-white/[.025] p-3 text-xs leading-5 text-zinc-500">
              {captionCues.length ? `${captionCues.length} blocos de legenda carregados para revisão.` : 'As legendas aparecem aqui após a etapa de captions.'}
            </div>
            <div className="mt-4 flex justify-end">
              <Button type="button" size="sm" onClick={() => void saveCaptions()} disabled={savingCaptions || !captionCues.length}>
                {savingCaptions ? <LoaderCircle className="size-4 animate-spin"/> : <Check className="size-4"/>}
                Salvar legendas
              </Button>
            </div>
          </Card>

          <form onSubmit={save} className={cn(activeTab !== 'seo' && 'hidden lg:block')}>
            <Card className="p-5">
              <h2 className="font-semibold text-white">Conteúdo e SEO</h2>
              <div className="mt-5 space-y-4">
                <div>
                  <Label htmlFor="clip-title">Título</Label>
                  <Input id="clip-title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={180}/>
                </div>
                <div>
                  <Label htmlFor="clip-description">Descrição</Label>
                  <Textarea id="clip-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000}/>
                </div>
                <div>
                  <Label htmlFor="clip-hashtags">Hashtags</Label>
                  <Input id="clip-hashtags" value={hashtags} onChange={(event) => setHashtags(event.target.value)} placeholder="#podcast #negócios"/>
                </div>
              </div>
              <div className="mt-5 flex justify-end">
                <Button disabled={saving}>{saving ? <LoaderCircle className="size-4 animate-spin"/> : <Check className="size-4"/>}Salvar</Button>
              </div>
            </Card>
          </form>

          <Card className={cn('p-5', activeTab !== 'export' && 'hidden lg:block')}>
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-lime"/>
              <h2 className="font-semibold text-white">Exportar corte</h2>
            </div>
            <p className="mt-3 text-sm leading-6 text-zinc-500">
              Renderize em MP4 H.264 no formato selecionado. O download assinado aparecerá quando a exportação concluir.
            </p>
            {exportRequested && !clip.downloadUrl && (
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-lime/20 bg-lime/10 px-3 py-2 text-sm text-lime">
                <LoaderCircle className="size-4 animate-spin"/>
                Renderizando. Esta tela atualiza automaticamente.
              </div>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              {clip.downloadUrl && (
                <Button asChild variant="secondary">
                  <a href={clip.downloadUrl} download={clipDownloadFilename(clip)}><Download className="size-4"/>Baixar MP4</a>
                </Button>
              )}
              <Button onClick={() => void createExport()} disabled={exporting}>
                {exporting ? <LoaderCircle className="size-4 animate-spin"/> : <Sparkles className="size-4"/>}
                Renderizar/exportar
              </Button>
            </div>
          </Card>

          {clip.titleSuggestions?.length ? (
            <Card className={cn('p-5', activeTab !== 'seo' && 'hidden lg:block')}>
              <div className="flex items-center gap-2">
                <RefreshCw className="size-4 text-lime"/>
                <h2 className="font-semibold text-white">Sugestões de título</h2>
              </div>
              <div className="mt-4 space-y-2">
                {clip.titleSuggestions.slice(0, 5).map((suggestion, index) => {
                  const text = typeof suggestion === 'string' ? suggestion : suggestion.title;
                  return (
                    <button
                      key={`${text}-${index}`}
                      onClick={() => setTitle(text)}
                      type="button"
                      className="w-full rounded-xl border border-white/[.07] p-3 text-left text-sm text-zinc-300 transition hover:border-lime/30 hover:text-white"
                    >
                      {text}
                    </button>
                  );
                })}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

function roundSeconds(value: number): number {
  return Math.round(value * 10) / 10;
}

function clipDownloadFilename(clip: Clip): string {
  const title = (clip.title ?? `picashorts-clip-${clip.id.slice(0, 8)}`)
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return /\.mp4$/i.test(title) ? title : `${title}.mp4`;
}

function extractCaptionSample(cues: unknown[]): string {
  const fallback = 'Legenda sincronizada do corte';
  const first = cues[0];
  if (!first || typeof first !== 'object') return fallback;
  const record = first as { text?: unknown; words?: Array<{ word?: unknown }> };
  if (typeof record.text === 'string' && record.text.trim()) return record.text.trim().split(' ').slice(0, 7).join(' ');
  const words = Array.isArray(record.words) ? record.words.map((word) => word.word).filter((word): word is string => typeof word === 'string') : [];
  return words.length ? words.slice(0, 7).join(' ') : fallback;
}
