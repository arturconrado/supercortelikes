'use client';

import { CheckCircle2, Clipboard, FileVideo, Info, Link2, LoaderCircle, UploadCloud, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { DragEvent, FormEvent, useRef, useState } from 'react';
import { Alert, Button, Card, Input, Label, PageHeader, Progress } from '@/components/ui';
import { api, endpoints } from '@/lib/api';
import { useResource } from '@/hooks/use-resource';
import type { UsageSnapshot, Video, VideoProcessingOptions } from '@/lib/types';
import { cn, formatBytes } from '@/lib/utils';
import { uploadVideo, validateVideo } from '@/lib/upload';

type QueueItem = {
  file: File;
  progress: number;
  status: 'waiting' | 'uploading' | 'done' | 'error';
  error?: string;
  result?: Video;
  controller?: AbortController;
};

const DEFAULT_PROCESSING_OPTIONS: VideoProcessingOptions = {
  durationPreset: 'AUTO',
  minimumDurationSeconds: 15,
  maximumDurationSeconds: 90,
  clipCount: 20,
  aspectRatio: '9:16',
  targetPlatform: 'AUTO',
};

const durationPresets: Array<{ value: VideoProcessingOptions['durationPreset']; label: string; description: string; min: number; max: number }> = [
  { value: 'AUTO', label: 'Auto', description: 'A IA decide o melhor tamanho', min: 15, max: 90 },
  { value: '15_30', label: '15–30s', description: 'Shorts rápidos', min: 15, max: 30 },
  { value: '30_60', label: '30–60s', description: 'Reels/TikTok padrão', min: 30, max: 60 },
  { value: '60_90', label: '60–90s', description: 'Cortes mais completos', min: 60, max: 90 },
];

const aspectRatios: Array<{ value: VideoProcessingOptions['aspectRatio']; label: string; description: string }> = [
  { value: '9:16', label: '9:16', description: 'TikTok/Reels/Shorts' },
  { value: '1:1', label: '1:1', description: 'Feed quadrado' },
  { value: '4:5', label: '4:5', description: 'Instagram vertical' },
  { value: '16:9', label: '16:9', description: 'YouTube horizontal' },
];

const targetPlatforms: Array<{ value: VideoProcessingOptions['targetPlatform']; label: string }> = [
  { value: 'AUTO', label: 'Automático' },
  { value: 'TIKTOK', label: 'TikTok' },
  { value: 'INSTAGRAM_REELS', label: 'Reels' },
  { value: 'YOUTUBE_SHORTS', label: 'Shorts' },
  { value: 'LINKEDIN', label: 'LinkedIn' },
  { value: 'YOUTUBE', label: 'YouTube' },
];

export default function UploadPage() {
  const router = useRouter();
  const quota = useResource<UsageSnapshot>(endpoints.usage);
  const limits = quota.data?.limits;
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [source, setSource] = useState<'file' | 'url'>('file');
  const [url, setUrl] = useState('');
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlError, setUrlError] = useState('');
  const [urlSuccess, setUrlSuccess] = useState('');
  const [urlTouched, setUrlTouched] = useState(false);
  const [processingOptions, setProcessingOptions] = useState<VideoProcessingOptions>(DEFAULT_PROCESSING_OPTIONS);
  const input = useRef<HTMLInputElement>(null);

  function addFiles(files: FileList | File[]) {
    const candidates = Array.from(files);
    setItems((current) => [
      ...current,
      ...candidates.map((file) => {
        const error = validateVideo(file, limits);
        return { file, progress: 0, status: error ? 'error' : 'waiting', error } as QueueItem;
      }),
    ]);
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  }

  function update(index: number, patch: Partial<QueueItem>) {
    setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  async function start() {
    const singleFile = items.length === 1;
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (item.status !== 'waiting' && item.status !== 'error') continue;
      if (validateVideo(item.file, limits)) continue;
      const controller = new AbortController();
      update(index, { status: 'uploading', error: undefined, controller });
      try {
        const result = await uploadVideo(
          item.file,
          (progress) => update(index, { progress }),
          controller.signal,
          limits,
          processingOptions,
        );
        update(index, { status: 'done', progress: 100, result, controller: undefined });
        if (singleFile) router.push(`/library/${result.id}`);
      } catch (reason) {
        if ((reason as Error).name === 'AbortError') {
          update(index, { status: 'waiting', progress: 0, controller: undefined });
        } else {
          update(index, {
            status: 'error',
            error: reason instanceof Error ? reason.message : 'Falha no upload.',
            controller: undefined,
          });
        }
      }
    }
  }

  async function importUrl(event: FormEvent) {
    event.preventDefault();
    const value = url.trim();
    const validation = validateImportUrl(value);
    if (validation) {
      setUrlTouched(true);
      setUrlError(validation);
      return;
    }
    setUrlBusy(true);
    setUrlError('');
    setUrlSuccess('');
    try {
      const video = await api<Video>(endpoints.imports, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ url: value, processingOptions }),
      });
      setUrl('');
      setUrlSuccess('Importação iniciada. Abrindo a tela do vídeo…');
      router.push(`/library/${video.id}`);
    } catch (reason) {
      setUrlError(importErrorMessage(reason));
    } finally {
      setUrlBusy(false);
    }
  }

  async function pasteUrl() {
    setUrlError('');
    try {
      const value = await navigator.clipboard.readText();
      setUrl(value.trim());
      setUrlTouched(true);
    } catch {
      setUrlError('Não consegui acessar a área de transferência. Cole o link manualmente no campo.');
    }
  }

  const uploading = items.some((item) => item.status === 'uploading');
  const pending = items.some((item) => item.status === 'waiting' || (item.status === 'error' && !validateVideo(item.file, limits)));
  const completed = items.filter((item) => item.status === 'done').length;
  const urlValidation = urlTouched ? validateImportUrl(url.trim()) : '';

  return (
    <>
      <PageHeader
        eyebrow="Novo conteúdo"
        title="Transforme seu vídeo em cortes"
        description="Cole um link ou envie um arquivo. Escolha o formato dos cortes antes da IA começar."
      />

      <div className="mb-6 inline-flex rounded-xl border border-white/[.08] bg-white/[.025] p-1">
        <button aria-label="Selecionar upload por arquivo" onClick={() => setSource('file')} className={`rounded-lg px-4 py-2 text-sm font-medium ${source === 'file' ? 'bg-white/[.09] text-white' : 'text-zinc-500'}`}>
          <UploadCloud className="mr-2 inline size-4"/>Arquivo
        </button>
        <button aria-label="Selecionar importação por URL" onClick={() => setSource('url')} className={`rounded-lg px-4 py-2 text-sm font-medium ${source === 'url' ? 'bg-white/[.09] text-white' : 'text-zinc-500'}`}>
          <Link2 className="mr-2 inline size-4"/>URL pública
        </button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div>
          <ProcessingOptionsPanel value={processingOptions} onChange={setProcessingOptions}/>

          {source === 'file' ? (
            <>
              <button
                type="button"
                onClick={() => input.current?.click()}
                onDragEnter={() => setDragging(true)}
                onDragLeave={() => setDragging(false)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={drop}
                className={`mt-6 group grid min-h-72 w-full place-items-center rounded-3xl border-2 border-dashed p-8 text-center transition ${dragging ? 'border-lime bg-lime/[.06]' : 'border-white/10 bg-panel/50 hover:border-lime/40 hover:bg-lime/[.025]'}`}
              >
                <div>
                  <div className="mx-auto grid size-16 place-items-center rounded-2xl bg-lime/[.08] transition group-hover:scale-105">
                    <UploadCloud className="size-7 text-lime"/>
                  </div>
                  <h2 className="mt-5 font-semibold text-white">Arraste seus vídeos aqui</h2>
                  <p className="mt-2 text-sm text-zinc-500">ou clique para escolher no computador</p>
                  <p className="mt-5 text-xs text-zinc-700">MP4, MOV, WEBM, MKV ou AVI · máximo 5 GB por arquivo</p>
                </div>
              </button>
              <input
                ref={input}
                type="file"
                accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,.mp4,.mov,.webm,.mkv,.avi"
                multiple
                className="hidden"
                onChange={(event) => event.target.files && addFiles(event.target.files)}
              />

              {items.length > 0 && (
                <Card className="mt-5 divide-y divide-white/[.06]">
                  {items.map((item, index) => (
                    <div key={`${item.file.name}-${item.file.lastModified}-${index}`} className="flex items-center gap-4 p-4">
                      <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-white/[.05]">
                        {item.status === 'done' ? <CheckCircle2 className="size-5 text-emerald-400"/> : <FileVideo className="size-5 text-zinc-500"/>}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex justify-between gap-3">
                          <p className="truncate text-sm font-medium text-white">{item.file.name}</p>
                          <span className="shrink-0 text-xs text-zinc-600">{item.status === 'uploading' ? `${item.progress}%` : formatBytes(item.file.size)}</span>
                        </div>
                        {item.status === 'uploading' && <Progress value={item.progress} className="mt-2"/>}
                        {item.error && <p className="mt-1 text-xs text-red-300">{item.error}</p>}
                        {item.status === 'done' && <p className="mt-1 text-xs text-emerald-400">Upload concluído · processamento iniciado</p>}
                      </div>
                      {item.status === 'uploading' ? (
                        <button onClick={() => item.controller?.abort()} className="p-2 text-zinc-500 hover:text-white" aria-label="Cancelar upload">
                          <X className="size-4"/>
                        </button>
                      ) : item.status !== 'done' && (
                        <button onClick={() => setItems((current) => current.filter((_, i) => i !== index))} className="p-2 text-zinc-500 hover:text-white" aria-label="Remover arquivo">
                          <X className="size-4"/>
                        </button>
                      )}
                    </div>
                  ))}
                </Card>
              )}

              {items.length > 0 && (
                <div className="mt-5 flex items-center justify-between">
                  <p className="text-xs text-zinc-600">{completed ? `${completed} de ${items.length} enviados` : `${items.length} arquivo(s) selecionado(s)`}</p>
                  <Button disabled={uploading || !pending} onClick={() => void start()}>
                    {uploading && <LoaderCircle className="size-4 animate-spin"/>}
                    {uploading ? 'Enviando…' : completed ? 'Enviar restantes' : 'Iniciar upload'}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <Card className="mt-6 p-6 sm:p-8">
              <div className="max-w-xl">
                <div className="grid size-12 place-items-center rounded-xl bg-red-500/10">
                  <Link2 className="size-5 text-red-300"/>
                </div>
                <h2 className="mt-5 text-xl font-bold text-white">Importar por URL</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-500">Cole YouTube, Loom, Google Drive público ou link direto de vídeo que você tem direito de processar.</p>
                <form onSubmit={importUrl} className="mt-6">
                  {urlError && <div className="mb-4"><Alert>{urlError}</Alert></div>}
                  {urlSuccess && <div className="mb-4 rounded-xl border border-emerald-500/15 bg-emerald-500/[.08] p-3.5 text-sm text-emerald-200">{urlSuccess}</div>}
                  <Label htmlFor="video-url">URL do vídeo</Label>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <div className="flex-1">
                      <Input
                        id="video-url"
                        type="url"
                        required
                        value={url}
                        onBlur={() => setUrlTouched(true)}
                        onChange={(event) => { setUrl(event.target.value); setUrlTouched(true); setUrlError(''); }}
                        placeholder="https://www.youtube.com/watch?v=..."
                        aria-invalid={Boolean(urlValidation)}
                      />
                      <p className={`mt-2 text-xs leading-5 ${urlValidation ? 'text-red-300' : 'text-zinc-600'}`}>
                        {urlValidation || 'Links públicos são importados em segundo plano. YouTube pode exigir cookies quando bloquear automação.'}
                      </p>
                    </div>
                    <Button type="button" variant="secondary" onClick={() => void pasteUrl()} className="shrink-0">
                      <Clipboard className="size-4"/>
                      Colar
                    </Button>
                    <Button disabled={urlBusy} className="shrink-0">
                      {urlBusy && <LoaderCircle className="size-4 animate-spin"/>}
                      Importar
                    </Button>
                  </div>
                  <div className="mt-4 rounded-xl border border-white/[.06] bg-white/[.025] p-3 text-xs leading-5 text-zinc-500">
                    <Info className="mr-1 inline size-3 text-lime"/>
                    Se uma plataforma bloquear a importação automática, o fluxo continua claro: envie o arquivo manualmente ou configure cookies no importador da VPS.
                  </div>
                </form>
              </div>
            </Card>
          )}
        </div>

        <UploadInfo quota={quota.data} options={processingOptions} files={items.map((item) => item.file)}/>
      </div>
    </>
  );
}

function ProcessingOptionsPanel({ value, onChange }: { value: VideoProcessingOptions; onChange: (value: VideoProcessingOptions) => void }) {
  function setPreset(preset: VideoProcessingOptions['durationPreset']) {
    const selected = durationPresets.find((item) => item.value === preset);
    onChange({
      ...value,
      durationPreset: preset,
      minimumDurationSeconds: selected?.min ?? value.minimumDurationSeconds,
      maximumDurationSeconds: selected?.max ?? value.maximumDurationSeconds,
    });
  }

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="font-semibold text-white">Configurações dos cortes</h2>
          <p className="mt-1 text-xs text-zinc-600">Escolha duração, quantidade e formato antes de processar.</p>
        </div>
        <span className="mt-2 rounded-full bg-lime/10 px-3 py-1 text-[11px] font-semibold text-lime sm:mt-0">Estilo OpusClip</span>
      </div>

      <div className="mt-5">
        <Label>Duração dos cortes</Label>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {durationPresets.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => setPreset(preset.value)}
              className={cn('rounded-xl border p-3 text-left transition', value.durationPreset === preset.value ? 'border-lime/50 bg-lime/[.08]' : 'border-white/[.08] bg-white/[.025] hover:border-white/[.16]')}
            >
              <span className="block text-sm font-semibold text-white">{preset.label}</span>
              <span className="mt-1 block text-[11px] text-zinc-600">{preset.description}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-3">
        <div>
          <Label htmlFor="clip-count">Quantidade de cortes</Label>
          <select
            id="clip-count"
            value={value.clipCount}
            onChange={(event) => onChange({ ...value, clipCount: Number(event.target.value) })}
            className="h-11 w-full rounded-xl border border-white/10 bg-white/[.035] px-3.5 text-sm text-white outline-none"
          >
            {[5, 10, 20, 30].map((count) => <option key={count} value={count}>{count} cortes</option>)}
          </select>
        </div>
        <div>
          <Label>Formato</Label>
          <div className="grid grid-cols-2 gap-2">
            {aspectRatios.map((ratio) => (
              <button
                key={ratio.value}
                type="button"
                onClick={() => onChange({ ...value, aspectRatio: ratio.value })}
                className={cn('rounded-xl border px-3 py-2 text-left transition', value.aspectRatio === ratio.value ? 'border-lime/50 bg-lime/[.08]' : 'border-white/[.08] bg-white/[.025] hover:border-white/[.16]')}
              >
                <span className="block text-sm font-semibold text-white">{ratio.label}</span>
                <span className="mt-1 block text-[10px] text-zinc-600">{ratio.description}</span>
              </button>
            ))}
          </div>
        </div>
        <div>
          <Label htmlFor="target-platform">Plataforma alvo</Label>
          <select
            id="target-platform"
            value={value.targetPlatform}
            onChange={(event) => onChange({ ...value, targetPlatform: event.target.value as VideoProcessingOptions['targetPlatform'] })}
            className="h-11 w-full rounded-xl border border-white/10 bg-white/[.035] px-3.5 text-sm text-white outline-none"
          >
            {targetPlatforms.map((platform) => <option key={platform.value} value={platform.value}>{platform.label}</option>)}
          </select>
          <p className="mt-2 text-[11px] leading-4 text-zinc-600">A plataforma ajuda a IA a priorizar duração, gancho e SEO.</p>
        </div>
      </div>
    </Card>
  );
}

function UploadInfo({ quota, options, files }: { quota?: UsageSnapshot; options: VideoProcessingOptions; files: File[] }) {
  const estimatedMinutes = estimateMinutes(options, files);
  return (
    <Card className="h-fit p-5">
      <h3 className="font-semibold text-white">Seu plano</h3>
      {quota ? (
        <div className="mt-3 rounded-xl border border-white/[.06] bg-white/[.025] p-3 text-xs leading-5 text-zinc-500">
          <div className="flex justify-between"><span>{quota.plan}</span><span>{quota.usage.remaining} min restantes</span></div>
          <Progress value={quota.usage.limit ? quota.usage.minutes / quota.usage.limit * 100 : 0} className="mt-2"/>
          <p className="mt-2">Upload até {formatBytes(quota.limits.maxUploadBytes)} · {exportQualityLabel(quota.limits.exportResolution)}{quota.limits.watermark ? ' · com marca d’água' : ''}</p>
        </div>
      ) : null}
      <div className="mt-4 rounded-xl border border-lime/15 bg-lime/[.06] p-3 text-xs leading-5 text-lime">
        <p className="font-semibold">Estimativa desta sessão</p>
        <p className="mt-1 text-lime/80">
          {estimatedMinutes > 0 ? `Até ${estimatedMinutes} min de processamento planejado` : `${options.clipCount} cortes · ${options.aspectRatio} · ${options.targetPlatform}`}
        </p>
      </div>
      <h3 className="mt-6 font-semibold text-white">O que acontece depois?</h3>
      <ol className="mt-5 space-y-5">
        {[
          ['01', 'Transcrição precisa', 'Falantes, pausas e palavras sincronizadas.'],
          ['02', 'Curadoria por IA', 'Os trechos recebem contexto e viral score.'],
          ['03', 'Edição automática', 'Reframe, legendas e títulos prontos para revisar.'],
        ].map(([number, title, text]) => (
          <li key={number} className="flex gap-3">
            <span className="text-xs font-bold text-lime">{number}</span>
            <div><p className="text-sm font-medium text-zinc-200">{title}</p><p className="mt-1 text-xs leading-5 text-zinc-600">{text}</p></div>
          </li>
        ))}
      </ol>
      <div className="mt-6 border-t border-white/[.06] pt-5 text-xs leading-5 text-zinc-600">Ao enviar, você confirma que possui os direitos necessários sobre o conteúdo.</div>
    </Card>
  );
}

function exportQualityLabel(value: '720p' | '1080p' | 'source'): string {
  return value === 'source' ? 'qualidade da origem até 4K' : `export ${value}`;
}

function validateImportUrl(value: string): string {
  if (!value) return 'Cole uma URL pública para iniciar a importação.';
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'Use uma URL começando com http:// ou https://.';
    if (!parsed.hostname.includes('.')) return 'Informe um domínio público válido.';
    return '';
  } catch {
    return 'Essa URL não parece válida. Confira o link e tente novamente.';
  }
}

function importErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : 'Não foi possível importar esse link.';
  const lower = message.toLowerCase();
  if (lower.includes('youtube') || lower.includes('cookie') || lower.includes('auth_required')) {
    return 'O YouTube bloqueou a importação automática deste link. Envie o arquivo manualmente ou configure cookies do YouTube no importador.';
  }
  return message;
}

function estimateMinutes(options: VideoProcessingOptions, files: File[]): number {
  if (!files.length) return 0;
  const perClipSeconds = Math.max(options.minimumDurationSeconds, Math.min(options.maximumDurationSeconds, 60));
  return Math.max(1, Math.ceil((options.clipCount * perClipSeconds) / 60));
}
