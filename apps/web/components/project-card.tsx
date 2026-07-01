import { Clapperboard, MoreHorizontal, Play } from 'lucide-react';
import Link from 'next/link';
import type { Project } from '@/lib/types';
import { formatDate } from '@/lib/utils';
import { StatusBadge } from './ui';

export function ProjectCard({ project }: { project: Project }) {
  return <Link href={`/projects/${project.id}`} className="group overflow-hidden rounded-2xl border border-white/[.08] bg-panel transition hover:-translate-y-0.5 hover:border-white/[.16]"><div className="relative aspect-video overflow-hidden bg-gradient-to-br from-zinc-800 to-zinc-950">{project.thumbnailUrl ? <img src={project.thumbnailUrl} alt="" className="h-full w-full object-cover transition duration-500 group-hover:scale-105"/> : <div className="grid h-full place-items-center"><Clapperboard className="size-9 text-zinc-700"/></div>}<div className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100"><div className="rounded-full bg-lime p-3 text-black"><Play className="size-4 fill-current"/></div></div><div className="absolute right-3 top-3"><StatusBadge status={project.status}/></div></div><div className="p-4"><div className="flex items-start justify-between gap-3"><h3 className="truncate font-semibold text-white">{project.name}</h3><MoreHorizontal className="size-4 shrink-0 text-zinc-600"/></div><div className="mt-3 flex items-center justify-between text-xs text-zinc-600"><span>{project.clipsCount ?? 0} cortes</span><span>{formatDate(project.updatedAt ?? project.createdAt)}</span></div></div></Link>;
}
