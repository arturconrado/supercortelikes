'use client';

import type { AnalyticsPoint } from '@/lib/types';

export function ActivityChart({ points = [] }: { points?: AnalyticsPoint[] }) {
  if (!points.length) return <div className="grid h-56 place-items-center text-sm text-zinc-600">A atividade aparecerá após o primeiro processamento.</div>;
  const values = points.map((point) => point.processings ?? point.minutes ?? 0); const max = Math.max(...values, 1);
  const coords = values.map((value, index) => `${values.length === 1 ? 50 : index / (values.length - 1) * 100},${100 - value / max * 80}`).join(' ');
  return <div><svg viewBox="0 0 100 105" preserveAspectRatio="none" className="h-48 w-full overflow-visible" role="img" aria-label="Atividade no período"><defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#c9ff42" stopOpacity=".22"/><stop offset="1" stopColor="#c9ff42" stopOpacity="0"/></linearGradient></defs><line x1="0" x2="100" y1="100" y2="100" stroke="rgba(255,255,255,.08)"/><polygon points={`0,100 ${coords} 100,100`} fill="url(#chart-fill)"/><polyline points={coords} fill="none" stroke="#c9ff42" strokeWidth="1.8" vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round"/></svg><div className="mt-2 flex justify-between text-[10px] text-zinc-600">{points.filter((_, index) => index === 0 || index === points.length - 1 || index === Math.floor(points.length / 2)).map((point) => <span key={point.date}>{new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(new Date(point.date))}</span>)}</div></div>;
}
