import { Clock3, Download, ExternalLink, Play, Zap } from 'lucide-react';
import Link from 'next/link';
import type { Clip } from '@/lib/types';
import { formatDuration } from '@/lib/utils';
import { Button, StatusBadge } from './ui';

type ClipCardProps = {
  clip: Clip;
  onPreview?: (clip: Clip) => void;
};

export function ClipCard({ clip, onPreview }: ClipCardProps) {
  const duration = clip.durationSeconds ?? ((clip.endSeconds ?? 0) - (clip.startSeconds ?? 0));
  const score = Math.round(clip.score ?? 0);
  const scoreClass = score >= 85 ? 'text-lime' : score >= 70 ? 'text-amber-300' : 'text-zinc-300';
  const media = (
    <div className="relative aspect-[9/12] overflow-hidden bg-gradient-to-br from-zinc-800 to-black">
      {clip.thumbnailUrl ? (
        <img src={clip.thumbnailUrl} alt={`Thumbnail do corte ${clip.title}`} className="h-full w-full object-cover transition duration-500 group-hover:scale-105"/>
      ) : (
        <div className="grid h-full place-items-center">
          <Play className="size-8 text-zinc-700"/>
        </div>
      )}
      <div className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition group-hover:bg-black/30 group-hover:opacity-100">
        <span className="rounded-full bg-lime p-3 text-black">
          <Play className="size-4 fill-current"/>
        </span>
      </div>
      <div className="absolute left-3 top-3 flex gap-2">
        <StatusBadge status={clip.status}/>
        {clip.score != null && (
          <span className={`flex items-center gap-1 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-bold backdrop-blur ${scoreClass}`}>
            <Zap className="size-3 fill-current"/>
            {score}
          </span>
        )}
      </div>
      <span className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-[10px] text-white">
        <Clock3 className="size-3"/>
        {formatDuration(duration)}
      </span>
    </div>
  );

  const body = (
    <div className="p-4">
      <h3 className="line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-white">{clip.title}</h3>
      <p className="mt-2 text-xs text-zinc-600">{clip.aspectRatio ?? '9:16'} · Viral score {score}</p>
      {onPreview && (
        <div className={`mt-4 grid gap-2 ${clip.downloadUrl ? 'grid-cols-3' : 'grid-cols-2'}`}>
          <Button type="button" size="sm" variant="secondary" onClick={() => onPreview(clip)}>
            <Play className="size-3.5"/>
            Preview
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href={`/clips/${clip.id}`}>
              <ExternalLink className="size-3.5"/>
              Editar
            </Link>
          </Button>
          {clip.downloadUrl && (
            <Button asChild size="sm" variant="ghost">
              <a href={clip.downloadUrl} download={clipDownloadFilename(clip)}>
                <Download className="size-3.5"/>
                Baixar
              </a>
            </Button>
          )}
        </div>
      )}
    </div>
  );

  if (onPreview) {
    return <article className="group overflow-hidden rounded-2xl border border-white/[.08] bg-panel transition hover:border-white/[.16]">{media}{body}</article>;
  }

  return <Link href={`/clips/${clip.id}`} className="group overflow-hidden rounded-2xl border border-white/[.08] bg-panel transition hover:border-white/[.16]">{media}{body}</Link>;
}

function clipDownloadFilename(clip: Clip): string {
  const title = (clip.title ?? `picashorts-clip-${clip.id.slice(0, 8)}`)
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return /\.mp4$/i.test(title) ? title : `${title}.mp4`;
}
