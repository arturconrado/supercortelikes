import Link from 'next/link';
import { Scissors } from 'lucide-react';

export function Logo({ compact = false }: { compact?: boolean }) {
  return <Link href="/dashboard" className="inline-flex items-center gap-2.5 font-bold tracking-tight text-white"><span className="grid size-9 place-items-center rounded-xl bg-lime text-black shadow-glow"><Scissors className="size-4" /></span>{!compact && <span>Pica<span className="text-lime">Shorts</span></span>}</Link>;
}
