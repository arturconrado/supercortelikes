'use client';

import { Activity, Bot, Check, ChevronRight, FileText, Gauge, Globe, Image, Layers3, PackageCheck, Plus, Radar, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, endpoints } from '@/lib/api';
import type { BrowserAutomationRun, MarketOpportunity, OpportunityCockpit } from '@/lib/types';
import { useResource } from '@/hooks/use-resource';
import { Alert, Badge, Button, Card, EmptyState, Input, Label, MetricCard, Modal, Progress, Skeleton, Textarea } from '@/components/ui';

const statusLabels: Record<MarketOpportunity['status'], string> = {
  OBSERVING: 'Observando',
  TESTING: 'Testando',
  ACTIVE: 'Ativo',
  SCALING: 'Escalando',
  DECLINING: 'Declinio',
  MIGRATING: 'Migrando',
  DEAD: 'Morto',
};

const statusFlow: MarketOpportunity['status'][] = ['OBSERVING', 'TESTING', 'ACTIVE', 'SCALING', 'DECLINING', 'MIGRATING', 'DEAD'];

export default function OpportunitiesPage() {
  const { data, loading, error, refresh } = useResource<OpportunityCockpit>(endpoints.opportunities);
  const browserRuns = useResource<BrowserAutomationRun[]>(endpoints.browserAutomations);
  const [busy, setBusy] = useState<string>();
  const [modalOpen, setModalOpen] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [form, setForm] = useState({
    title: '',
    audience: '',
    pain: '',
    category: '',
    format: 'Planilha + guia rapido',
    offerType: 'PRODUCT' as MarketOpportunity['offerType'],
    demandScore: 75,
    saturationScore: 45,
    monetizationScore: 70,
    channelFitScore: 75,
  });

  const sorted = useMemo(() => data?.opportunities ?? [], [data]);
  const hasRunningLaunch = useMemo(() => sorted.some((opportunity) => opportunity.products?.some((product) => {
    const run = product.launchRuns?.[0];
    return run && ['RUNNING', 'DRAFT', 'READY'].includes(run.status);
  })), [sorted]);

  useEffect(() => {
    if (!hasRunningLaunch) return undefined;
    const timer = window.setInterval(() => {
      void refresh();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [hasRunningLaunch, refresh]);

  async function runAction(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    try {
      await action();
      await refresh();
      await browserRuns.refresh();
    } finally {
      setBusy(undefined);
    }
  }

  async function scout() {
    await runAction('scout', () => api(`${endpoints.opportunities}/scout`, { method: 'POST', body: '{}' }));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);
    try {
      await api(endpoints.opportunities, {
        method: 'POST',
        body: JSON.stringify({ ...form, signals: [{ source: 'manual', label: 'Sinal informado pelo operador', strength: form.demandScore }] }),
      });
      setModalOpen(false);
      await refresh();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : 'Nao foi possivel criar a oportunidade.');
    }
  }

  return <>
    <div className="mb-7 flex min-w-0 flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div className="min-w-0">
        <p className="mb-2 text-xs font-bold uppercase tracking-[.18em] text-lime">Esteira agentica</p>
        <h1 className="break-words text-2xl font-bold tracking-tight text-white sm:text-3xl">Cockpit de microprodutos</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-500">Descubra nichos, aplique score deterministico, aprove gates humanos e gere o pacote inicial de produto sem perder controle operacional.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setModalOpen(true)}><Plus className="size-4"/>Nova oportunidade</Button>
        <Button onClick={() => void scout()} disabled={busy === 'scout'}><Radar className="size-4"/>Rodar scout</Button>
      </div>
    </div>

    {error && <div className="mb-5"><Alert>{error}</Alert></div>}

    <div className="mb-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard icon={Radar} label="Oportunidades" value={loading ? '...' : data?.counts.total ?? 0} detail="nichos no radar" />
      <MetricCard icon={Activity} label="Em teste" value={loading ? '...' : `${data?.counts.testing ?? 0}/${data?.limits.maxTesting ?? 3}`} detail="limite operacional" />
      <MetricCard icon={Gauge} label="Ativos" value={loading ? '...' : `${data?.counts.active ?? 0}/${data?.limits.maxActive ?? 5}`} detail="portfolio controlado" />
      <MetricCard icon={PackageCheck} label="Produtos" value={loading ? '...' : data?.counts.products ?? 0} detail="pacotes gerados" />
    </div>

    {loading ? <div className="grid gap-4 xl:grid-cols-2">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-80" />)}</div> : sorted.length ? (
      <div className="grid gap-4 xl:grid-cols-2">
        {sorted.map((opportunity) => <OpportunityCard key={opportunity.id} opportunity={opportunity} busy={busy} runAction={runAction} />)}
      </div>
    ) : (
      <EmptyState icon={Bot} title="Nenhum nicho no radar" description="Rode o scout para criar candidatos iniciais ou cadastre uma oportunidade manual com sinais que voce ja observou." action={<Button onClick={() => void scout()}><Sparkles className="size-4"/>Gerar candidatos</Button>} />
    )}

    <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Nova oportunidade" description="Cadastre um nicho com scores objetivos. O LLM pode explicar, mas o score vem dos numeros.">
      <form onSubmit={submit} className="space-y-4">
        {formError && <Alert>{formError}</Alert>}
        <div><Label>Titulo</Label><Input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></div>
        <div><Label>Publico</Label><Input required value={form.audience} onChange={(event) => setForm({ ...form, audience: event.target.value })} /></div>
        <div><Label>Dor especifica</Label><Textarea required value={form.pain} onChange={(event) => setForm({ ...form, pain: event.target.value })} /></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label>Categoria</Label><Input required value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} /></div>
          <div><Label>Formato</Label><Input required value={form.format} onChange={(event) => setForm({ ...form, format: event.target.value })} /></div>
        </div>
        <div>
          <Label>Tipo de oferta</Label>
          <select value={form.offerType} onChange={(event) => setForm({ ...form, offerType: event.target.value as MarketOpportunity['offerType'] })} className="h-11 w-full rounded-xl border border-white/10 bg-white/[.035] px-3.5 text-sm text-white outline-none focus:border-lime/50 focus:ring-2 focus:ring-lime/10">
            <option value="PRODUCT">Produto digital</option>
            <option value="SERVICE">Servico produtizado</option>
            <option value="HYBRID">Produto + servico</option>
          </select>
        </div>
        <ScoreInput label="Demanda" value={form.demandScore} onChange={(value) => setForm({ ...form, demandScore: value })} />
        <ScoreInput label="Saturacao" value={form.saturationScore} onChange={(value) => setForm({ ...form, saturationScore: value })} />
        <ScoreInput label="Monetizacao" value={form.monetizationScore} onChange={(value) => setForm({ ...form, monetizationScore: value })} />
        <ScoreInput label="Forca de canal" value={form.channelFitScore} onChange={(value) => setForm({ ...form, channelFitScore: value })} />
        <div className="flex justify-end gap-2 pt-2"><Button type="button" variant="ghost" onClick={() => setModalOpen(false)}>Cancelar</Button><Button>Criar</Button></div>
      </form>
    </Modal>

    {!!browserRuns.data?.length && <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">Execucoes recentes de browser</h2>
      <div className="grid gap-3 xl:grid-cols-2">
        {browserRuns.data.slice(0, 4).map((run) => <Card key={run.id} className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">{run.result?.title || run.goal}</p>
              <p className="mt-1 truncate text-xs text-zinc-500">{run.targetUrl}</p>
            </div>
            <Badge tone={run.status === 'SUCCEEDED' ? 'good' : run.status === 'FAILED' ? 'bad' : 'warn'}>{run.status.replaceAll('_', ' ')}</Badge>
          </div>
          {run.result?.summary && <p className="mt-3 line-clamp-2 text-sm leading-6 text-zinc-400">{run.result.summary}</p>}
        </Card>)}
      </div>
    </section>}
  </>;
}

function OpportunityCard({ opportunity, busy, runAction }: {
  opportunity: MarketOpportunity;
  busy?: string;
  runAction: (key: string, action: () => Promise<unknown>) => Promise<void>;
}) {
  const [researchUrl, setResearchUrl] = useState('');
  const nextStatus = statusFlow[Math.min(statusFlow.indexOf(opportunity.status) + 1, statusFlow.length - 1)];
  const key = (action: string) => `${action}:${opportunity.id}`;
  return <Card className="p-5">
    <div className="flex min-w-0 items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap gap-2">
          <Badge tone={opportunity.gateDecision === 'APPROVED' ? 'good' : opportunity.gateDecision === 'REJECTED' ? 'bad' : 'warn'}>{opportunity.gateDecision === 'APPROVED' ? 'Aprovado' : opportunity.gateDecision === 'REJECTED' ? 'Rejeitado' : 'Gate pendente'}</Badge>
          <Badge tone="neutral">{statusLabels[opportunity.status]}</Badge>
          <Badge tone="lime">{offerLabel(opportunity.offerType)}</Badge>
          <Badge tone="neutral">{opportunity.format}</Badge>
        </div>
        <h2 className="break-words text-lg font-bold text-white">{opportunity.title}</h2>
        <p className="mt-1 text-sm leading-6 text-zinc-500">{opportunity.audience}</p>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-3xl font-bold text-white">{opportunity.score}</div>
        <div className="text-[11px] uppercase tracking-wider text-zinc-600">score</div>
      </div>
    </div>

    <p className="mt-4 text-sm leading-6 text-zinc-400">{opportunity.pain}</p>
    <div className="mt-5 grid gap-3 sm:grid-cols-2">
      <ScoreBar label="Demanda" value={opportunity.demandScore} />
      <ScoreBar label="Baixa saturacao" value={100 - opportunity.saturationScore} />
      <ScoreBar label="Monetizacao" value={opportunity.monetizationScore} />
      <ScoreBar label="Canal" value={opportunity.channelFitScore} />
    </div>

    <div className="mt-5 rounded-xl border border-white/[.07] bg-white/[.025] p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Racional do agente</p>
      <p className="mt-2 text-sm leading-6 text-zinc-300">{opportunity.agentRationale}</p>
      <p className="mt-2 text-sm leading-6 text-lime">{opportunity.nextAction}</p>
    </div>

    {!!opportunity.signals?.length && <div className="mt-4 flex flex-wrap gap-2">
      {opportunity.signals.map((signal) => <Badge key={signal.id} tone="neutral">{signal.source}: {signal.strength}</Badge>)}
    </div>}

    {!!opportunity.products?.length && <div className="mt-4 rounded-xl border border-emerald-500/10 bg-emerald-500/[.04] p-3 text-sm text-emerald-200">
      {opportunity.products.length} oferta(s) gerada(s), melhor QA: {Math.max(...opportunity.products.map((product) => product.qualityScore))}/100
      <div className="mt-2 flex flex-wrap gap-2">
        {opportunity.products.at(0)?.mediaPlan.channels?.slice(0, 5).map((channel) => <Badge key={channel.kind} tone="good">{mediaKindLabel(channel.kind)} x{channel.count}</Badge>)}
      </div>
      <MediaAssetPreview product={opportunity.products[0]} busy={busy} runAction={runAction} />
    </div>}

    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      <MediaHint icon={FileText} label="Oferta" value={offerLabel(opportunity.offerType)} />
      <MediaHint icon={Image} label="Midias" value={(opportunity.recommendedMedia?.required ?? []).slice(0, 3).map(mediaKindLabel).join(', ')} />
    </div>

    <div className="mt-5 flex flex-wrap gap-2">
      {opportunity.gateDecision !== 'APPROVED' && <Button size="sm" onClick={() => runAction(key('approve'), () => api(`${endpoints.opportunities}/${opportunity.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'APPROVED' }) }))} disabled={busy === key('approve')}><Check className="size-4"/>Aprovar</Button>}
      {opportunity.gateDecision !== 'REJECTED' && <Button size="sm" variant="ghost" onClick={() => runAction(key('reject'), () => api(`${endpoints.opportunities}/${opportunity.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'REJECTED' }) }))} disabled={busy === key('reject')}><X className="size-4"/>Rejeitar</Button>}
      <Button size="sm" variant="secondary" onClick={() => runAction(key('product'), () => api(`${endpoints.opportunities}/${opportunity.id}/products`, { method: 'POST', body: '{}' }))} disabled={busy === key('product') || opportunity.gateDecision !== 'APPROVED'}><PackageCheck className="size-4"/>Gerar oferta + midias</Button>
      <Button size="sm" variant="secondary" onClick={() => runAction(key('launch'), () => api(`${endpoints.opportunities}/${opportunity.id}/launch`, { method: 'POST', body: '{}' }))} disabled={busy === key('launch') || opportunity.gateDecision !== 'APPROVED'}><Sparkles className="size-4"/>Iniciar esteira</Button>
      {nextStatus !== opportunity.status && <Button size="sm" variant="secondary" onClick={() => runAction(key('advance'), () => api(`${endpoints.opportunities}/${opportunity.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) }))} disabled={busy === key('advance') || opportunity.gateDecision !== 'APPROVED'}>{statusLabels[nextStatus]}<ChevronRight className="size-4"/></Button>}
    </div>

    <div className="mt-4 flex flex-col gap-2 border-t border-white/[.06] pt-4 sm:flex-row">
      <Input value={researchUrl} onChange={(event) => setResearchUrl(event.target.value)} placeholder="https://fonte-publica.com/pagina-do-nicho" className="sm:flex-1" />
      <Button
        size="sm"
        variant="secondary"
        disabled={!researchUrl || busy === key('browser')}
        onClick={() => runAction(key('browser'), () => api(`${endpoints.browserAutomations}/research`, {
          method: 'POST',
          body: JSON.stringify({
            opportunityId: opportunity.id,
            targetUrl: researchUrl,
            goal: `Coletar evidencias de demanda e linguagem para: ${opportunity.title}`,
            kind: 'MARKET_RESEARCH',
          }),
        }).then(() => setResearchUrl('')))}
      >
        <Globe className="size-4"/>Pesquisar com browser
      </Button>
    </div>
  </Card>;
}

function MediaAssetPreview({ product, busy, runAction }: {
  product: NonNullable<MarketOpportunity['products']>[number];
  busy?: string;
  runAction: (key: string, action: () => Promise<unknown>) => Promise<void>;
}) {
  const assets = product.mediaAssets ?? [];
  const drafts = product.publicationDrafts ?? [];
  const latestRun = product.launchRuns?.[0];
  const key = (action: string) => `${action}:${product.id}`;
  return <div className="mt-3 border-t border-emerald-500/10 pt-3">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-100"><Layers3 className="size-4"/>Biblioteca de midias</div>
      <Button size="sm" variant="ghost" disabled={busy === key('assets')} onClick={() => runAction(key('assets'), () => api(`${endpoints.opportunities}/products/${product.id}/media-assets`, { method: 'POST', body: '{}' }))}>Regenerar</Button>
    </div>
    {assets.length ? <div className="grid gap-2 sm:grid-cols-2">
      {assets.slice(0, 6).map((asset) => <div key={asset.id} className="rounded-lg border border-white/[.08] bg-black/10 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-white">{asset.title}</p>
            <p className="mt-1 text-[11px] text-emerald-100/70">{mediaKindLabel(asset.kind.toLowerCase())} · {asset.channel}</p>
          </div>
          <Badge tone={asset.status === 'APPROVED' ? 'good' : asset.status === 'READY' ? 'lime' : 'warn'}>{asset.status.replaceAll('_', ' ')}</Badge>
        </div>
        <p className="mt-2 line-clamp-2 text-xs leading-5 text-emerald-50/75">{asset.objective}</p>
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="secondary" disabled={busy === `approve-asset:${asset.id}`} onClick={() => runAction(`approve-asset:${asset.id}`, () => api(`${endpoints.opportunities}/media-assets/${asset.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'APPROVED' }) }))}>Aprovar</Button>
        </div>
      </div>)}
    </div> : <p className="text-xs text-emerald-100/70">Gere as midias para materializar pagina, criativos, scripts e sequencias.</p>}
    {(drafts.length > 0 || latestRun) && <div className="mt-3 rounded-lg border border-white/[.08] bg-black/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-emerald-100">Lancamento</p>
        {latestRun && <Badge tone={latestRun.status === 'COMPLETED' ? 'good' : latestRun.status === 'FAILED' ? 'bad' : 'warn'}>{latestRun.status.replaceAll('_', ' ')}</Badge>}
      </div>
      <p className="mt-2 text-xs leading-5 text-emerald-50/75">{launchStatusText(latestRun?.status, drafts.length)}</p>
      {!!latestRun?.stages?.length && <div className="mt-2 flex flex-wrap gap-2">
        {latestRun.stages.map((stage) => <Badge key={stage.stage} tone={stage.status === 'SUCCEEDED' ? 'good' : stage.status === 'FAILED' ? 'bad' : stage.status === 'PROCESSING' ? 'lime' : 'warn'}>{stageLabel(stage.stage)} · {stage.status.replaceAll('_', ' ')}</Badge>)}
      </div>}
    </div>}
  </div>;
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  return <div>
    <div className="mb-1 flex justify-between text-xs"><span className="text-zinc-500">{label}</span><span className="font-semibold text-white">{value}</span></div>
    <Progress value={value} />
  </div>;
}

function MediaHint({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return <div className="flex min-w-0 items-center gap-3 rounded-xl border border-white/[.07] bg-white/[.025] p-3">
    <Icon className="size-4 shrink-0 text-lime" />
    <div className="min-w-0"><p className="text-[11px] uppercase tracking-wider text-zinc-600">{label}</p><p className="truncate text-sm text-zinc-300">{value || 'A definir'}</p></div>
  </div>;
}

function offerLabel(type: MarketOpportunity['offerType']) {
  const labels = { PRODUCT: 'Produto digital', SERVICE: 'Servico', HYBRID: 'Produto + servico' };
  return labels[type];
}

function mediaKindLabel(kind: string) {
  const labels: Record<string, string> = {
    landing_page: 'Pagina',
    static_image: 'Imagem',
    carousel: 'Carrossel',
    short_video: 'Video curto',
    whatsapp_copy: 'WhatsApp',
    email: 'E-mail',
    audio_script: 'Audio',
    diagnostic_form: 'Diagnostico',
    proposal_pdf: 'Proposta',
    service_onepager: 'One-pager',
  };
  return labels[kind] ?? kind.replaceAll('_', ' ');
}

function stageLabel(stage: string) {
  const labels: Record<string, string> = {
    OFFER: 'Oferta',
    MEDIA_ASSETS: 'Midias',
    PUBLICATION_DRAFTS: 'Drafts',
    METRICS_SETUP: 'Metricas',
  };
  return labels[stage] ?? stage;
}

function launchStatusText(status: string | undefined, drafts: number) {
  if (status === 'RUNNING') return 'Esteira agentica em execucao. A tela atualiza sozinha enquanto os estagios avancam.';
  if (status === 'FAILED') return 'A esteira falhou. Revise o erro e rode novamente depois do ajuste.';
  if (status === 'REVIEW_REQUIRED') return `${drafts} draft(s) de publicacao prontos para revisao humana.`;
  return `${drafts} draft(s) de publicacao registrados.`;
}

function ScoreInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <div>
    <div className="mb-2 flex justify-between"><Label className="mb-0">{label}</Label><span className="text-sm font-semibold text-white">{value}</span></div>
    <input type="range" min={0} max={100} value={value} onChange={(event) => onChange(Number(event.target.value))} className="w-full accent-lime" />
  </div>;
}
