import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type GateDecision, type MediaAssetStatus, type OfferType, type OpportunityStatus } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';
import { OFFER_PRODUCTION_STAGES, type OfferProductionJob } from '../offer-production/offer-production.constants';
import type { AdvanceOpportunityDto, CreateMetricSnapshotDto, CreateOpportunityDto, DecideOpportunityDto, ScoutOpportunitiesDto } from './opportunities.dto';

const MAX_TESTING = 3;
const MAX_ACTIVE = 5;

const scoutSeeds = [
  {
    title: 'Planilha de precificacao para confeiteiras MEI',
    audience: 'Confeiteiras MEI que vendem por encomenda',
    pain: 'Dificuldade para calcular custo real, margem, embalagem e taxa de entrega sem vender no prejuizo.',
    category: 'Financas para pequenos negocios',
    format: 'Planilha + guia rapido',
    offerType: 'PRODUCT' as const,
    demandScore: 86,
    saturationScore: 42,
    monetizationScore: 78,
    channelFitScore: 82,
    sources: ['youtube', 'marketplaces', 'instagram'],
  },
  {
    title: 'Controle financeiro para motoristas de app',
    audience: 'Motoristas de aplicativo autônomos',
    pain: 'Falta de clareza sobre lucro liquido depois de combustivel, manutencao, taxas e impostos.',
    category: 'Produtividade financeira',
    format: 'Planilha + checklist semanal',
    offerType: 'HYBRID' as const,
    demandScore: 81,
    saturationScore: 38,
    monetizationScore: 74,
    channelFitScore: 76,
    sources: ['youtube', 'search', 'comunidades'],
  },
  {
    title: 'Cronograma de estudos para concurso de enfermagem',
    audience: 'Tecnicos e estudantes de enfermagem prestando concurso',
    pain: 'Excesso de materias e pouco tempo para revisar conteudos recorrentes de editais.',
    category: 'Educacao e concursos',
    format: 'Planner + banco de revisao',
    offerType: 'PRODUCT' as const,
    demandScore: 88,
    saturationScore: 51,
    monetizationScore: 72,
    channelFitScore: 79,
    sources: ['youtube', 'google trends', 'marketplaces'],
  },
  {
    title: 'Kit de mensagens para vender pelo WhatsApp',
    audience: 'Autonomos e pequenos negocios locais',
    pain: 'Medo de parecer insistente e dificuldade de fazer follow-up, recuperar orcamentos e fechar vendas.',
    category: 'Vendas e atendimento',
    format: 'Kit de scripts + exemplos',
    offerType: 'SERVICE' as const,
    demandScore: 83,
    saturationScore: 45,
    monetizationScore: 81,
    channelFitScore: 85,
    sources: ['instagram', 'youtube', 'comunidades'],
  },
];

@Injectable()
export class OpportunitiesService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(user: AuthenticatedUser): Promise<unknown> {
    const [opportunities, products] = await Promise.all([
      this.prisma.marketOpportunity.findMany({
        where: { workspaceId: user.workspaceId },
        orderBy: [{ score: 'desc' }, { updatedAt: 'desc' }],
        include: {
          signals: { orderBy: { strength: 'desc' }, take: 5 },
          products: {
            orderBy: { createdAt: 'desc' },
            take: 3,
            include: {
              mediaAssets: { orderBy: { createdAt: 'asc' }, take: 20 },
              publicationDrafts: { orderBy: { createdAt: 'desc' }, take: 20 },
              launchRuns: { orderBy: { createdAt: 'desc' }, take: 3, include: { stages: { orderBy: { createdAt: 'asc' } } } },
            },
          },
        },
      }),
      this.prisma.digitalProduct.findMany({
      where: { workspaceId: user.workspaceId },
      orderBy: { updatedAt: 'desc' },
      take: 12,
        include: {
          opportunity: { select: { id: true, title: true, status: true, score: true } },
          mediaAssets: { orderBy: { createdAt: 'asc' }, take: 20 },
          publicationDrafts: { orderBy: { createdAt: 'desc' }, take: 20 },
          launchRuns: { orderBy: { createdAt: 'desc' }, take: 3, include: { stages: { orderBy: { createdAt: 'asc' } } } },
        },
      }),
    ]);

    const byStatus = opportunities.reduce<Record<string, number>>((acc, item) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1;
      return acc;
    }, {});
    return {
      limits: { maxTesting: MAX_TESTING, maxActive: MAX_ACTIVE },
      counts: {
        total: opportunities.length,
        testing: byStatus.TESTING ?? 0,
        active: byStatus.ACTIVE ?? 0,
        approved: opportunities.filter((item) => item.gateDecision === 'APPROVED').length,
        products: products.length,
      },
      byStatus,
      opportunities,
      products,
    };
  }

  async create(user: AuthenticatedUser, input: CreateOpportunityDto): Promise<unknown> {
    const prepared = prepareOpportunity(input);
    return this.prisma.marketOpportunity.create({
      data: {
        workspaceId: user.workspaceId,
        createdById: user.userId,
        ...prepared,
        signals: { create: signalInputs(input.signals, prepared.sourceTags as string[]) },
      },
      include: { signals: true, products: true },
    });
  }

  async scout(user: AuthenticatedUser, input: ScoutOpportunitiesDto): Promise<{ created: number; opportunities: unknown[] }> {
    const theme = input.theme?.trim().toLowerCase();
    const seeds = theme ? scoutSeeds.filter((seed) => seed.title.toLowerCase().includes(theme) || seed.category.toLowerCase().includes(theme)) : scoutSeeds;
    const selected = seeds.length ? seeds : scoutSeeds.slice(0, 2);
    const opportunities = [];
    for (const seed of selected) {
      const existing = await this.prisma.marketOpportunity.findFirst({
        where: { workspaceId: user.workspaceId, title: seed.title },
        select: { id: true },
      });
      if (existing) continue;
      const prepared = prepareOpportunity(seed);
      opportunities.push(await this.prisma.marketOpportunity.create({
        data: {
          workspaceId: user.workspaceId,
          createdById: user.userId,
          ...prepared,
          signals: { create: signalInputs(undefined, seed.sources) },
        },
        include: { signals: true, products: true },
      }));
    }
    await this.audit(user, 'opportunity.scout', null, { created: opportunities.length, theme: input.theme ?? null });
    return { created: opportunities.length, opportunities };
  }

  async decide(user: AuthenticatedUser, id: string, input: DecideOpportunityDto): Promise<unknown> {
    const opportunity = await this.findOwned(user, id);
    const approved = input.decision === 'APPROVED';
    const updated = await this.prisma.marketOpportunity.update({
      where: { id: opportunity.id },
      data: {
        gateDecision: input.decision as GateDecision,
        status: approved && opportunity.status === 'OBSERVING' ? 'TESTING' : opportunity.status,
        approvedAt: approved ? new Date() : null,
        rejectedAt: approved ? null : new Date(),
        nextAction: approved ? 'Gerar pacote inicial e validar oferta com criativos pequenos.' : 'Arquivar aprendizados e buscar angulo alternativo antes de investir.',
      },
      include: { signals: true, products: true },
    });
    await this.audit(user, 'opportunity.decide', id, { decision: input.decision });
    return updated;
  }

  async advance(user: AuthenticatedUser, id: string, input: AdvanceOpportunityDto): Promise<unknown> {
    const opportunity = await this.findOwned(user, id);
    if (input.status !== 'OBSERVING' && opportunity.gateDecision !== 'APPROVED') {
      throw new ConflictException('A oportunidade precisa ser aprovada no gate humano antes de avancar.');
    }
    await this.assertCapacity(user.workspaceId, input.status, id);
    const updated = await this.prisma.marketOpportunity.update({
      where: { id },
      data: { status: input.status as OpportunityStatus, nextAction: nextActionFor(input.status) },
      include: { signals: true, products: true },
    });
    await this.audit(user, 'opportunity.advance', id, { status: input.status });
    return updated;
  }

  async generateProduct(user: AuthenticatedUser, id: string): Promise<unknown> {
    const opportunity = await this.findOwned(user, id);
    if (opportunity.gateDecision !== 'APPROVED') throw new ConflictException('Aprove a oportunidade antes de gerar produto.');
    const outline = buildOutline(opportunity);
    const qaFindings = runQa(outline);
    const product = await this.prisma.digitalProduct.create({
      data: {
        workspaceId: user.workspaceId,
        opportunityId: id,
        title: productTitle(opportunity.title),
        format: opportunity.format,
        status: qaFindings.length ? 'QA_REQUIRED' : 'READY',
        qualityScore: Math.max(0, 100 - qaFindings.length * 18),
        priceCents: 1900,
        offerType: opportunity.offerType,
        outline,
        serviceBlueprint: buildServiceBlueprint(opportunity) ?? Prisma.JsonNull,
        mediaPlan: buildMediaPlan(opportunity),
        qaFindings,
        assets: {
          salesPage: `/products/${id}/sales-page.html`,
          coverBrief: `Capa clara para ${opportunity.audience}, com promessa pratica e visual de ferramenta.`,
          staticImages: [
            `Mockup quadrado da oferta ${opportunity.title}`,
            `Imagem antes/depois mostrando a dor: ${opportunity.pain}`,
            `Banner vertical com promessa para ${opportunity.audience}`,
          ],
          carousels: [
            ['Dor principal', 'Erro comum', 'Metodo simples', 'Prova pratica', 'Chamada para acao'],
            ['Checklist rapido', 'Exemplo aplicado', 'Resultado esperado', 'Oferta'],
          ],
          shortVideos: [
            `Hook de 15s: ${opportunity.pain}`,
            `Demo de 30s do ${opportunity.format}`,
            `Depoimento/script de prova para ${opportunity.audience}`,
          ],
          audioScripts: [
            `Audio curto para WhatsApp apresentando ${opportunity.title}`,
            `Narração de Reels explicando a transformacao em 30 segundos`,
          ],
          emailSequence: ['Abertura da dor', 'Historia/exemplo', 'Oferta direta', 'Ultima chamada'],
          creativeAngles: [
            `Pare de improvisar: ${opportunity.pain}`,
            `Resolva em uma tarde: ${opportunity.title}`,
            `${opportunity.offerType === 'SERVICE' ? 'Servico pronto' : 'Template pronto'} para ${opportunity.audience}`,
          ],
          submissionChecklist: ['Revisar exemplos brasileiros', 'Exportar PDF', 'Criar mockup de capa', 'Submeter manualmente na plataforma escolhida'],
        },
      },
      include: { opportunity: true },
    });
    const mediaAssets = await this.replaceMediaAssets(product.id, user.workspaceId, buildMediaAssets(product.id, user.workspaceId, opportunity));
    await this.audit(user, 'opportunity.generate_product', id, { productId: product.id, qualityScore: product.qualityScore });
    return { ...product, mediaAssets };
  }

  async prepareLaunch(user: AuthenticatedUser, id: string): Promise<unknown> {
    const opportunity = await this.findOwned(user, id);
    if (opportunity.gateDecision !== 'APPROVED') throw new ConflictException('Aprove a oportunidade antes de preparar lancamento.');
    let product = await this.prisma.digitalProduct.findFirst({
      where: { opportunityId: id, workspaceId: user.workspaceId },
      orderBy: { createdAt: 'desc' },
      include: { mediaAssets: true, publicationDrafts: true },
    });
    if (!product) {
      await this.generateProduct(user, id);
      product = await this.prisma.digitalProduct.findFirst({
        where: { opportunityId: id, workspaceId: user.workspaceId },
        orderBy: { createdAt: 'desc' },
        include: { mediaAssets: true, publicationDrafts: true },
      });
    }
    if (!product) throw new ConflictException('Nao foi possivel criar a oferta para lancamento.');
    if (!product.mediaAssets.length) {
      await this.replaceMediaAssets(product.id, user.workspaceId, buildMediaAssets(product.id, user.workspaceId, opportunity));
      product = await this.prisma.digitalProduct.findUniqueOrThrow({ where: { id: product.id }, include: { mediaAssets: true, publicationDrafts: true } });
    }
    const steps = [
      { name: 'gate_humano', status: 'OK', detail: 'Oportunidade aprovada.' },
      { name: 'pipeline', status: 'RUNNING', detail: 'Execucao de oferta iniciada em estagios rastreaveis.' },
    ];
    const launchRun = await this.prisma.offerLaunchRun.create({
      data: {
        workspaceId: user.workspaceId,
        opportunityId: id,
        productId: product.id,
        status: 'RUNNING',
        mode: 'manual_pipeline',
        steps,
        stages: {
          create: OFFER_PRODUCTION_STAGES.map((stage) => ({ stage })),
        },
      },
      include: { stages: { orderBy: { createdAt: 'asc' } } },
    });
    const firstStage = launchRun.stages.find((stage) => stage.stage === 'OFFER');
    if (!firstStage) throw new ConflictException('Nao foi possivel iniciar a esteira de oferta.');
    const eventId = randomUUID();
    const job: OfferProductionJob = {
      schemaVersion: 1,
      eventId,
      launchRunId: launchRun.id,
      stageExecutionId: firstStage.id,
      opportunityId: id,
      productId: product.id,
      workspaceId: user.workspaceId,
      stage: 'OFFER',
      correlationId: launchRun.id,
      causationId: launchRun.id,
      occurredAt: new Date().toISOString(),
    };
    await this.prisma.offerProductionOutboxEvent.create({
      data: {
        id: eventId,
        launchRunId: launchRun.id,
        type: 'offer.production.requested.v1',
        payload: job,
      },
    });
    await this.audit(user, 'opportunity.prepare_launch', id, { productId: product.id, launchRunId: launchRun.id, mode: 'agentic_pipeline' });
    return { launchRun, product, publicationDrafts: product.publicationDrafts };
  }

  async createMetricSnapshot(user: AuthenticatedUser, id: string, input: CreateMetricSnapshotDto): Promise<unknown> {
    const opportunity = await this.findOwned(user, id);
    const product = await this.prisma.digitalProduct.findFirst({ where: { opportunityId: id, workspaceId: user.workspaceId }, orderBy: { createdAt: 'desc' } });
    const snapshot = await this.prisma.offerMetricSnapshot.create({
      data: {
        workspaceId: user.workspaceId,
        opportunityId: opportunity.id,
        productId: product?.id ?? null,
        source: input.source.trim(),
        impressions: input.impressions ?? 0,
        clicks: input.clicks ?? 0,
        leads: input.leads ?? 0,
        sales: input.sales ?? 0,
        revenueCents: input.revenueCents ?? 0,
        costCents: input.costCents ?? 0,
        metadata: {
          ctr: ratio(input.clicks ?? 0, input.impressions ?? 0),
          cvr: ratio(input.sales ?? 0, input.clicks ?? 0),
          roas: ratio(input.revenueCents ?? 0, input.costCents ?? 0),
        },
      },
    });
    await this.audit(user, 'opportunity.metric_snapshot', id, { source: snapshot.source, sales: snapshot.sales, revenueCents: snapshot.revenueCents });
    return snapshot;
  }

  async listMediaAssets(user: AuthenticatedUser, productId: string): Promise<unknown> {
    await this.findOwnedProduct(user, productId);
    return this.prisma.offerMediaAsset.findMany({ where: { productId, workspaceId: user.workspaceId }, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] });
  }

  async generateMediaAssets(user: AuthenticatedUser, productId: string): Promise<unknown> {
    const product = await this.findOwnedProduct(user, productId);
    const opportunity = await this.findOwned(user, product.opportunityId);
    const mediaAssets = await this.replaceMediaAssets(productId, user.workspaceId, buildMediaAssets(productId, user.workspaceId, opportunity));
    await this.audit(user, 'opportunity.generate_media_assets', opportunity.id, { productId, count: mediaAssets.length });
    return mediaAssets;
  }

  async updateMediaAssetStatus(user: AuthenticatedUser, assetId: string, input: { status: MediaAssetStatus }): Promise<unknown> {
    const asset = await this.prisma.offerMediaAsset.findFirst({ where: { id: assetId, workspaceId: user.workspaceId } });
    if (!asset) throw new NotFoundException('Media asset not found');
    const updated = await this.prisma.offerMediaAsset.update({ where: { id: assetId }, data: { status: input.status } });
    await this.audit(user, 'opportunity.media_asset_status', asset.productId, { assetId, status: input.status });
    return updated;
  }

  private async findOwned(user: AuthenticatedUser, id: string) {
    const opportunity = await this.prisma.marketOpportunity.findFirst({ where: { id, workspaceId: user.workspaceId } });
    if (!opportunity) throw new NotFoundException('Opportunity not found');
    return opportunity;
  }

  private async findOwnedProduct(user: AuthenticatedUser, productId: string) {
    const product = await this.prisma.digitalProduct.findFirst({ where: { id: productId, workspaceId: user.workspaceId } });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private async replaceMediaAssets(productId: string, workspaceId: string, assets: Array<Prisma.OfferMediaAssetCreateManyInput>) {
    await this.prisma.$transaction([
      this.prisma.offerMediaAsset.deleteMany({ where: { productId, workspaceId } }),
      this.prisma.offerMediaAsset.createMany({ data: assets }),
    ]);
    return this.prisma.offerMediaAsset.findMany({ where: { productId, workspaceId }, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] });
  }

  private async assertCapacity(workspaceId: string, status: string, excludeId: string): Promise<void> {
    if (status !== 'TESTING' && status !== 'ACTIVE') return;
    const limit = status === 'TESTING' ? MAX_TESTING : MAX_ACTIVE;
    const count = await this.prisma.marketOpportunity.count({ where: { workspaceId, status: status as OpportunityStatus, id: { not: excludeId } } });
    if (count >= limit) throw new ConflictException(`Limite operacional atingido para ${status}: maximo de ${limit}.`);
  }

  private async audit(user: AuthenticatedUser, action: string, resourceId: string | null, metadata: Prisma.InputJsonObject): Promise<void> {
    await this.prisma.auditLog.create({ data: { userId: user.userId, workspaceId: user.workspaceId, action, resource: 'market_opportunity', resourceId, metadata } });
  }
}

function prepareOpportunity(input: CreateOpportunityDto | (typeof scoutSeeds)[number]) {
  const score = Math.round(input.demandScore * 0.35 + (100 - input.saturationScore) * 0.2 + input.monetizationScore * 0.25 + input.channelFitScore * 0.2);
  const sourceTags = 'sources' in input ? input.sources : [...new Set((input.signals ?? []).map((signal) => signal.source.toLowerCase()))];
  return {
    title: input.title.trim(),
    audience: input.audience.trim(),
    pain: input.pain.trim(),
    category: input.category.trim(),
    format: input.format.trim(),
    offerType: (input.offerType ?? ('offerType' in input ? input.offerType : 'PRODUCT')) as OfferType,
    score,
    demandScore: input.demandScore,
    saturationScore: input.saturationScore,
    monetizationScore: input.monetizationScore,
    channelFitScore: input.channelFitScore,
    evidenceSummary: `Score ${score}/100 calculado por demanda, baixa saturacao relativa, potencial de monetizacao e aderencia de canal.`,
    agentRationale: score >= 75 ? 'Candidato forte para teste rapido com produto simples e criativos de dor direta.' : score >= 60 ? 'Candidato moderado; exige validacao manual dos sinais antes de investimento.' : 'Candidato fraco; manter em observacao ate surgirem sinais melhores.',
    nextAction: score >= 70 ? 'Enviar para gate humano e preparar validacao de oferta.' : 'Coletar mais sinais antes de produzir.',
    sourceTags,
    recommendedMedia: recommendedMediaFor((input.offerType ?? ('offerType' in input ? input.offerType : 'PRODUCT')) as OfferType, input.format),
  };
}

function signalInputs(signals: CreateOpportunityDto['signals'], fallbackSources: string[]) {
  if (signals?.length) return signals.map((signal) => ({ ...signal, source: signal.source.trim(), label: signal.label.trim(), url: signal.url || null }));
  return fallbackSources.map((source, index) => ({
    source,
    label: `Sinal inicial coletado em ${source}`,
    strength: Math.max(55, 82 - index * 7),
    metadata: { generatedBy: 'deterministic-scout-v1' },
  }));
}

function nextActionFor(status: string): string {
  const actions: Record<string, string> = {
    OBSERVING: 'Monitorar sinais e concorrencia antes de investir.',
    TESTING: 'Rodar oferta pequena com criativos e medir CTR/CVR.',
    ACTIVE: 'Manter produto vendendo e otimizar pagina/criativos.',
    SCALING: 'Aumentar distribuicao com controle de CAC e saturacao.',
    DECLINING: 'Reduzir investimento e procurar novo angulo.',
    MIGRATING: 'Transformar aprendizados em nicho adjacente.',
    DEAD: 'Encerrar ciclo e manter registro historico.',
  };
  return actions[status] ?? actions.OBSERVING;
}

function productTitle(title: string): string {
  return `${title}: oferta pronta`;
}

function buildOutline(opportunity: { title: string; audience: string; pain: string; format: string }) {
  return {
    promise: `Ajudar ${opportunity.audience} a resolver: ${opportunity.pain}`,
    modules: [
      { title: 'Diagnostico rapido', items: ['Identificar situacao atual', 'Mapear erros comuns', 'Definir meta pratica'] },
      { title: 'Metodo principal', items: ['Passo a passo', 'Exemplo preenchido', 'Modelo reutilizavel'] },
      { title: 'Aplicacao em 7 dias', items: ['Checklist diario', 'Ajustes por cenario', 'Metricas simples'] },
      { title: 'Venda/uso continuo', items: ['Rotina de manutencao', 'Quando revisar', 'Proximos passos'] },
    ],
    deliverables: [opportunity.format, 'Pagina de venda inicial', 'Checklist de QA', 'Hooks de criativos'],
  };
}

function buildServiceBlueprint(opportunity: { title: string; audience: string; pain: string; offerType: OfferType }) {
  if (opportunity.offerType === 'PRODUCT') return null;
  return {
    serviceName: `Implantacao assistida: ${opportunity.title}`,
    promise: `Resolver com acompanhamento a dor de ${opportunity.audience}: ${opportunity.pain}`,
    deliveryModel: opportunity.offerType === 'HYBRID' ? 'Produto digital + sessao/diagnostico de implantacao' : 'Servico produtizado de baixo ticket',
    steps: ['Diagnostico inicial', 'Configuracao/adaptacao do material', 'Entrega guiada', 'Revisao final'],
    sla: 'Entrega inicial em ate 3 dias uteis apos briefing completo.',
    boundaries: ['Nao inclui consultoria ilimitada', 'Nao inclui gestao continua sem novo pacote', 'Nao promete resultado financeiro garantido'],
  };
}

function buildMediaPlan(opportunity: { title: string; audience: string; pain: string; format: string; offerType: OfferType }) {
  const offerLabel = opportunity.offerType === 'SERVICE' ? 'servico' : opportunity.offerType === 'HYBRID' ? 'produto + servico' : 'produto';
  return {
    objective: `Validar ${offerLabel} para ${opportunity.audience}`,
    channels: [
      { kind: 'landing_page', count: 1, purpose: 'converter trafego em lead/compra', brief: `Pagina com promessa direta para ${opportunity.title}` },
      { kind: 'static_image', count: 3, purpose: 'testar dor e promessa', brief: `Criativos quadrados/verticais sobre ${opportunity.pain}` },
      { kind: 'carousel', count: 2, purpose: 'educar e quebrar objecoes', brief: `Sequencias mostrando erro, metodo e oferta` },
      { kind: 'short_video', count: 3, purpose: 'alcance e retencao', brief: `Roteiros curtos com hook, demo e prova` },
      { kind: 'whatsapp_copy', count: 6, purpose: 'follow-up e fechamento', brief: `Mensagens para ${opportunity.audience}` },
      { kind: 'email', count: 4, purpose: 'nutricao e recuperacao', brief: `Sequencia de oferta para ${opportunity.title}` },
      { kind: 'audio_script', count: 2, purpose: 'venda consultiva em voz', brief: `Audios curtos para WhatsApp/Reels` },
    ],
    humanGate: ['aprovar promessa', 'aprovar claims', 'aprovar publicacao/agendamento'],
  };
}

function recommendedMediaFor(offerType: OfferType, format: string) {
  const base = ['landing_page', 'static_image', 'carousel', 'whatsapp_copy', 'email'];
  const video = ['short_video', 'audio_script'];
  const service = ['diagnostic_form', 'proposal_pdf', 'service_onepager'];
  return {
    offerType,
    primaryFormat: format,
    required: offerType === 'PRODUCT' ? [...base, ...video] : offerType === 'SERVICE' ? [...base, ...service, ...video] : [...base, ...service, ...video],
    optional: ['lead_magnet', 'mockup', 'ad_copy', 'checkout_copy'],
  };
}

export function buildMediaAssets(productId: string, workspaceId: string, opportunity: {
  title: string;
  audience: string;
  pain: string;
  category: string;
  format: string;
  offerType: OfferType;
}): Array<Prisma.OfferMediaAssetCreateManyInput> {
  const promise = `Resolva ${opportunity.pain.toLowerCase()} com ${opportunity.format.toLowerCase()}.`;
  const cta = opportunity.offerType === 'SERVICE' ? 'Pedir diagnostico' : opportunity.offerType === 'HYBRID' ? 'Quero o pacote com implantacao' : 'Quero o material pronto';
  const base = {
    productId,
    workspaceId,
    status: 'READY' as const,
  };
  const assets: Array<Prisma.OfferMediaAssetCreateManyInput> = [
    {
      ...base,
      kind: 'LANDING_PAGE',
      title: `Pagina de venda - ${opportunity.title}`,
      channel: 'web',
      objective: 'Converter trafego frio em lead ou compra de baixo ticket.',
      brief: `Pagina direta para ${opportunity.audience}.`,
      body: {
        headline: opportunity.title,
        subheadline: promise,
        sections: [
          { title: 'Para quem e', text: opportunity.audience },
          { title: 'Dor que resolve', text: opportunity.pain },
          { title: 'O que recebe', text: opportunity.format },
          { title: 'Como usar', bullets: ['Baixe/acessa o material', 'Preencha com seus dados', 'Aplique a rotina por 7 dias', 'Revise resultados e ajuste'] },
          { title: 'Garantias de clareza', bullets: ['Sem promessa financeira garantida', 'Exemplos praticos', 'Checklist de aplicacao'] },
        ],
        cta,
      },
      qaChecklist: ['Promessa especifica', 'Sem claims proibidos', 'CTA unico', 'Beneficio claro acima da dobra'],
    },
    {
      ...base,
      kind: 'STATIC_IMAGE',
      title: `Criativo dor - ${opportunity.title}`,
      channel: 'instagram/meta ads',
      objective: 'Testar reconhecimento imediato da dor.',
      brief: `Imagem vertical com dor explicita para ${opportunity.audience}.`,
      body: {
        prompt: `Imagem limpa e brasileira sobre ${opportunity.audience}, mostrando frustracao com: ${opportunity.pain}. Incluir area livre para texto curto.`,
        overlayText: ['Voce ainda faz isso no improviso?', opportunity.title, cta],
        dimensions: ['1080x1350', '1080x1920', '1080x1080'],
      },
      qaChecklist: ['Texto legivel no mobile', 'Sem poluicao visual', 'Dor aparece em ate 2 segundos'],
    },
    {
      ...base,
      kind: 'STATIC_IMAGE',
      title: `Criativo solucao - ${opportunity.title}`,
      channel: 'instagram/meta ads',
      objective: 'Testar promessa pratica da oferta.',
      brief: `Mockup da entrega ${opportunity.format}.`,
      body: {
        prompt: `Mockup realista de ${opportunity.format} para ${opportunity.audience}, visual profissional, fundo claro, foco em organizacao e simplicidade.`,
        overlayText: ['Um modelo pronto para aplicar hoje', opportunity.format, cta],
        dimensions: ['1080x1350', '1080x1080'],
      },
      qaChecklist: ['Mostra a entrega', 'Promessa concreta', 'Nao parece generico'],
    },
    {
      ...base,
      kind: 'CAROUSEL',
      title: `Carrossel educativo - ${opportunity.title}`,
      channel: 'instagram/linkedin',
      objective: 'Educar, quebrar objecoes e preparar conversao.',
      brief: `Carrossel de 6 paginas para ${opportunity.audience}.`,
      body: {
        slides: [
          { title: 'O erro invisivel', text: opportunity.pain },
          { title: 'Por que isso custa caro', text: 'Sem metodo, voce decide no impulso e perde margem, tempo ou foco.' },
          { title: 'O jeito simples', text: `Use ${opportunity.format.toLowerCase()} com uma rotina curta.` },
          { title: 'Como aplicar', bullets: ['Diagnostique', 'Preencha', 'Execute', 'Revise'] },
          { title: 'Para quem serve', text: opportunity.audience },
          { title: 'Proximo passo', text: cta },
        ],
      },
      qaChecklist: ['Uma ideia por slide', 'CTA no ultimo slide', 'Dor antes da solucao'],
    },
    {
      ...base,
      kind: 'SHORT_VIDEO',
      title: `Roteiro Reels 30s - ${opportunity.title}`,
      channel: 'reels/tiktok/shorts',
      objective: 'Gerar atencao e cliques com demonstracao curta.',
      brief: `Video curto com gancho, prova visual e CTA.`,
      body: {
        durationSeconds: 30,
        script: [
          { time: '0-3s', scene: 'Close no problema', voice: `Se voce e ${opportunity.audience}, talvez esteja perdendo tempo com isso.` },
          { time: '3-10s', scene: 'Mostrar dor na tela', voice: opportunity.pain },
          { time: '10-22s', scene: 'Mostrar material/servico', voice: `Eu montei ${opportunity.format.toLowerCase()} para resolver isso de forma simples.` },
          { time: '22-30s', scene: 'CTA na tela', voice: cta },
        ],
        captions: true,
      },
      qaChecklist: ['Hook em 3 segundos', 'Legenda clara', 'CTA falado e visual'],
    },
    {
      ...base,
      kind: 'AUDIO_SCRIPT',
      title: `Audio WhatsApp - ${opportunity.title}`,
      channel: 'whatsapp',
      objective: 'Abordagem consultiva sem parecer insistente.',
      brief: `Audio curto para enviar apos interesse inicial.`,
      body: {
        maxSeconds: 35,
        script: `Oi! Vi que essa dor aparece bastante para ${opportunity.audience}: ${opportunity.pain}. Eu tenho uma oferta simples chamada ${opportunity.title}, pensada para aplicar rapido sem complicar. Se fizer sentido, eu te mando os detalhes e voce ve se encaixa no seu momento.`,
      },
      qaChecklist: ['Tom humano', 'Sem pressao excessiva', 'Pedido de permissao'],
    },
    {
      ...base,
      kind: 'WHATSAPP_COPY',
      title: `Sequencia WhatsApp - ${opportunity.title}`,
      channel: 'whatsapp',
      objective: 'Converter interessados e recuperar conversas paradas.',
      brief: `Mensagens curtas para abertura, prova e follow-up.`,
      body: {
        messages: [
          `Oi! Posso te mandar uma ideia rapida para resolver ${opportunity.pain.toLowerCase()}?`,
          `A proposta e simples: ${opportunity.format} para ${opportunity.audience}.`,
          `Funciona melhor para quem quer aplicar sem montar tudo do zero.`,
          `Quer que eu te mande o que vem incluso e o valor?`,
          `Passando aqui so para fechar o ciclo: ainda faz sentido olhar isso hoje?`,
          `Se nao for o momento, tranquilo. Posso te chamar quando eu tiver uma versao nova?`,
        ],
      },
      qaChecklist: ['Mensagens curtas', 'Permissao antes da oferta', 'Follow-up respeitoso'],
    },
    {
      ...base,
      kind: 'EMAIL',
      title: `Sequencia e-mail - ${opportunity.title}`,
      channel: 'email',
      objective: 'Nutrir lead e recuperar decisao.',
      brief: `Sequencia de 4 e-mails para oferta de baixo ticket.`,
      body: {
        emails: [
          { subject: `Um jeito simples de resolver ${opportunity.pain.slice(0, 48)}`, preview: promise, body: `O problema nao e falta de esforco. Muitas vezes falta um modelo simples. ${promise}` },
          { subject: 'O erro que mais atrapalha', preview: 'Improviso parece rapido, mas cobra juros.', body: `Quando ${opportunity.audience} tenta resolver isso sem metodo, o custo aparece em tempo, margem ou energia.` },
          { subject: `O que vem em ${opportunity.title}`, preview: opportunity.format, body: `Voce recebe ${opportunity.format}, exemplos e um caminho de aplicacao.` },
          { subject: 'Quer aplicar hoje?', preview: cta, body: `Se isso ainda faz sentido, o proximo passo e simples: ${cta}.` },
        ],
      },
      qaChecklist: ['Assunto claro', 'Uma CTA por e-mail', 'Sem promessa exagerada'],
    },
  ];

  if (opportunity.offerType !== 'PRODUCT') {
    assets.push(
      {
        ...base,
        kind: 'DIAGNOSTIC_FORM',
        title: `Formulario diagnostico - ${opportunity.title}`,
        channel: 'forms',
        objective: 'Coletar briefing antes da entrega do servico.',
        brief: `Perguntas para entender contexto de ${opportunity.audience}.`,
        body: {
          questions: [
            'Qual e sua situacao atual?',
            'Qual resultado pratico voce quer nos proximos 7 dias?',
            'O que ja tentou antes?',
            'Quais ferramentas ou dados voce ja possui?',
            'Qual restricao de tempo/orcamento precisamos respeitar?',
          ],
        },
        qaChecklist: ['Perguntas objetivas', 'Sem pedir dado sensivel desnecessario', 'Ajuda a delimitar escopo'],
      },
      {
        ...base,
        kind: 'PROPOSAL_PDF',
        title: `Proposta PDF - ${opportunity.title}`,
        channel: 'pdf',
        objective: 'Formalizar escopo, valor e limites do servico.',
        brief: `Documento curto para enviar apos diagnostico.`,
        body: {
          sections: [
            { title: 'Objetivo', text: promise },
            { title: 'Escopo', bullets: ['Diagnostico', 'Adaptacao do material', 'Entrega guiada', 'Revisao'] },
            { title: 'Fora do escopo', bullets: ['Suporte ilimitado', 'Garantia de resultado financeiro', 'Gestao continua'] },
            { title: 'Prazo', text: 'Entrega inicial em ate 3 dias uteis apos briefing completo.' },
            { title: 'Proximo passo', text: cta },
          ],
        },
        qaChecklist: ['Escopo claro', 'Limites claros', 'Prazo definido'],
      },
      {
        ...base,
        kind: 'SERVICE_ONEPAGER',
        title: `One-pager servico - ${opportunity.title}`,
        channel: 'web/pdf',
        objective: 'Explicar rapidamente o servico produtizado.',
        brief: `Resumo comercial de uma pagina.`,
        body: {
          headline: `Implantacao assistida para ${opportunity.audience}`,
          bullets: ['Diagnostico rapido', 'Material adaptado', 'Entrega guiada', 'Revisao final'],
          cta,
        },
        qaChecklist: ['Cabe em uma pagina', 'Mostra entregaveis', 'Mostra limites'],
      },
    );
  }

  return assets;
}

export function buildPublicationDrafts(productId: string, workspaceId: string, assets: Array<{ kind: string; title: string; channel: string; body: Prisma.JsonValue; objective: string }>): Array<Prisma.OfferPublicationDraftCreateManyInput> {
  return assets
    .filter((asset) => ['STATIC_IMAGE', 'CAROUSEL', 'SHORT_VIDEO', 'WHATSAPP_COPY', 'EMAIL', 'AUDIO_SCRIPT', 'LANDING_PAGE', 'SERVICE_ONEPAGER'].includes(asset.kind))
    .map((asset) => ({
      workspaceId,
      productId,
      provider: providerForAsset(asset.kind, asset.channel),
      channel: asset.channel,
      status: 'READY',
      title: asset.title,
      body: {
        objective: asset.objective,
        sourceAssetKind: asset.kind,
        content: asset.body,
        humanGate: ['review_copy', 'approve_claims', 'confirm_destination'],
      },
    }));
}

function providerForAsset(kind: string, channel: string): string {
  if (channel.includes('whatsapp')) return 'manual_whatsapp';
  if (channel.includes('email')) return 'manual_email';
  if (channel.includes('instagram') || channel.includes('reels') || channel.includes('tiktok')) return 'postiz_pending';
  if (kind === 'LANDING_PAGE') return 'site_pending';
  return 'manual';
}

function ratio(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

export function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function runQa(outline: { modules: Array<{ title: string; items: string[] }>; deliverables: string[] }) {
  const findings: string[] = [];
  if (outline.modules.length < 3) findings.push('Produto precisa de pelo menos tres modulos.');
  if (outline.modules.some((module) => module.items.length < 3)) findings.push('Cada modulo precisa de pelo menos tres itens praticos.');
  if (outline.deliverables.length < 3) findings.push('Pacote precisa listar entregaveis suficientes.');
  return findings;
}
