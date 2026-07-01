'use client';

import { ArrowLeft, Film, MoreHorizontal, RefreshCw, Scissors } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ClipCard } from '@/components/clip-card';
import { Alert, Button, Card, EmptyState, PageHeader, Skeleton, StatusBadge } from '@/components/ui';
import { useResource } from '@/hooks/use-resource';
import { api } from '@/lib/api';
import type { Project } from '@/lib/types';
import { formatDate } from '@/lib/utils';

export default function ProjectPage() {
  const { id } = useParams<{id:string}>(); const { data: project, loading, error, refresh } = useResource<Project>(`/projects/${id}`); const [running, setRunning] = useState(false); const [actionError, setActionError] = useState('');
  async function reprocess() { setRunning(true); setActionError(''); try { await api(`/projects/${id}/process`, { method: 'POST' }); await refresh(); } catch(reason) { setActionError(reason instanceof Error ? reason.message : 'Não foi possível iniciar o processamento.'); } finally { setRunning(false); } }
  if (loading) return <><Skeleton className="h-24"/><Skeleton className="mt-6 h-[480px]"/></>; if (error || !project) return <Alert>{error ?? 'Projeto não encontrado.'}</Alert>;
  return <><Link href="/projects" className="mb-5 inline-flex items-center gap-2 text-sm text-zinc-500 hover:text-white"><ArrowLeft className="size-4"/>Projetos</Link><PageHeader eyebrow={`Criado em ${formatDate(project.createdAt)}`} title={project.name} description={project.description ?? 'Cortes e versões geradas para este projeto.'} action={<div className="flex gap-2"><Button variant="secondary" onClick={() => void reprocess()} disabled={running}><RefreshCw className={`size-4 ${running?'animate-spin':''}`}/>Reprocessar</Button><Button variant="ghost" aria-label="Mais opções"><MoreHorizontal className="size-4"/></Button></div>}/>{actionError && <div className="mb-5"><Alert>{actionError}</Alert></div>}<Card className="mb-7 flex flex-wrap items-center gap-x-8 gap-y-4 p-5"><div><p className="text-xs text-zinc-600">Status</p><div className="mt-2"><StatusBadge status={project.status}/></div></div><div><p className="text-xs text-zinc-600">Vídeos</p><p className="mt-1 text-xl font-bold text-white">{project.videosCount ?? project.videos?.length ?? 0}</p></div><div><p className="text-xs text-zinc-600">Cortes</p><p className="mt-1 text-xl font-bold text-white">{project.clipsCount ?? project.clips?.length ?? 0}</p></div></Card><div className="mb-4 flex items-end justify-between"><div><h2 className="font-semibold text-white">Cortes encontrados</h2><p className="mt-1 text-xs text-zinc-600">Ordenados pelo potencial de retenção</p></div></div>{project.clips?.length ? <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{project.clips.map((clip)=><ClipCard key={clip.id} clip={clip}/>)}</div> : <EmptyState icon={project.status === 'PROCESSING' ? Scissors : Film} title={project.status === 'PROCESSING' ? 'A IA está encontrando os melhores momentos' : 'Este projeto ainda não tem cortes'} description={project.status === 'PROCESSING' ? 'Os cortes aparecerão aqui conforme o processamento avançar.' : 'Adicione um vídeo ou inicie o processamento para gerar cortes.'} action={project.status !== 'PROCESSING' && <Button asChild size="sm"><Link href="/upload">Enviar vídeo</Link></Button>}/>}</>;
}
