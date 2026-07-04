'use client';

import { Download, FileOutput, LoaderCircle, RefreshCw, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Progress, Skeleton, StatusBadge } from '@/components/ui';
import { useCollection } from '@/hooks/use-resource';
import { api, endpoints } from '@/lib/api';
import { startFileDownload } from '@/lib/download';
import type { ExportJob } from '@/lib/types';
import { formatBytes, formatDate } from '@/lib/utils';

type DownloadResponse = { url: string; expiresInSeconds: number };

const IN_PROGRESS = new Set(['PENDING', 'QUEUED', 'PROCESSING', 'RENDERING']);

export default function ExportsPage() {
  const { data, loading, error, refresh } = useCollection<ExportJob>(endpoints.exports);
  const [acting, setActing] = useState<string>();
  const [actionError, setActionError] = useState('');

  const hasInProgressExports = useMemo(() => data.some((job) => IN_PROGRESS.has(job.status)), [data]);

  useEffect(() => {
    if (!hasInProgressExports) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 3500);
    return () => window.clearInterval(timer);
  }, [hasInProgressExports, refresh]);

  async function download(job: ExportJob) {
    if (!job.downloadUrl) return;
    setActing(`download:${job.id}`);
    setActionError('');
    try {
      const response = await api<DownloadResponse>(job.downloadUrl);
      startFileDownload(response.url, exportFilename(job));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Não foi possível baixar a exportação.');
    } finally {
      setActing(undefined);
    }
  }

  async function retry(job: ExportJob) {
    setActing(`retry:${job.id}`);
    setActionError('');
    try {
      await api(`/exports/${job.id}/retry`, { method: 'POST' });
      await refresh();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Não foi possível repetir a exportação.');
    } finally {
      setActing(undefined);
    }
  }

  async function cancel(job: ExportJob) {
    setActing(`cancel:${job.id}`);
    setActionError('');
    try {
      await api(`/exports/${job.id}`, { method: 'DELETE' });
      await refresh();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Não foi possível cancelar.');
    } finally {
      setActing(undefined);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Entregas"
        title="Exportações"
        description="Acompanhe renders e baixe os arquivos finalizados."
      />

      {(error || actionError) && (
        <div className="mb-5">
          <Alert>{error ?? actionError}</Alert>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-24"/>)}
        </div>
      ) : !data.length ? (
        <EmptyState
          icon={FileOutput}
          title="Nenhuma exportação ainda"
          description="Abra um corte pronto, escolha o formato e gere seu primeiro arquivo."
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-[1fr_110px_120px_120px_150px] gap-4 border-b border-white/[.06] px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-600 md:grid">
            <span>Corte</span>
            <span>Formato</span>
            <span>Criado</span>
            <span>Status</span>
            <span className="text-right">Ações</span>
          </div>
          <div className="divide-y divide-white/[.06]">
            {data.map((job) => (
              <div key={job.id} className="grid gap-4 p-5 md:grid-cols-[1fr_110px_120px_120px_150px] md:items-center">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">{job.clipTitle ?? `Exportação ${job.id.slice(0, 8)}`}</p>
                  {IN_PROGRESS.has(job.status) && (
                    <div className="mt-2 flex items-center gap-3">
                      <Progress value={job.progress ?? 0} className="max-w-52 flex-1"/>
                      <span className="text-[10px] text-zinc-600">{job.progress ?? 0}%</span>
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <Badge>{job.format}</Badge>
                  {job.aspectRatio && <Badge>{job.aspectRatio}</Badge>}
                </div>
                <span className="text-xs text-zinc-500">{formatDate(job.createdAt)}</span>
                <div><StatusBadge status={job.status}/></div>
                <div className="flex justify-end gap-2">
                  {job.downloadUrl && (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void download(job)}
                      disabled={acting === `download:${job.id}`}
                    >
                      {acting === `download:${job.id}` ? <LoaderCircle className="size-3 animate-spin"/> : <Download className="size-3"/>}
                      {job.sizeBytes ? formatBytes(job.sizeBytes) : 'Baixar'}
                    </Button>
                  )}
                  {job.status === 'FAILED' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void retry(job)}
                      disabled={acting === `retry:${job.id}`}
                    >
                      {acting === `retry:${job.id}` ? <LoaderCircle className="size-3 animate-spin"/> : <RefreshCw className="size-3"/>}
                      Repetir
                    </Button>
                  )}
                  {IN_PROGRESS.has(job.status) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void cancel(job)}
                      disabled={acting === `cancel:${job.id}`}
                      aria-label="Cancelar"
                    >
                      <XCircle className="size-4"/>
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

function exportFilename(job: ExportJob): string {
  const title = (job.clipTitle ?? `picashorts-export-${job.id.slice(0, 8)}`)
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return /\.mp4$/i.test(title) ? title : `${title}.mp4`;
}
