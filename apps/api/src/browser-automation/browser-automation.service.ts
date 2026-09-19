import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { chromium, type Browser, type Page } from 'playwright';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';
import type { BrowserResearchDto } from './browser-automation.dto';

const ALLOWED_RESEARCH_ACTIONS = ['navigate', 'read_dom', 'extract_title', 'extract_headings', 'extract_links', 'capture_signal'];
const BLOCKED_SENSITIVE_ACTIONS = ['login', 'fill_form', 'submit_form', 'purchase', 'publish', 'schedule_post', 'upload_file', 'send_message'];
const MAX_TEXT_CHARS = 5000;

type BrowserStep = { action: string; status: 'OK' | 'FAILED' | 'BLOCKED'; detail: string; at: string };

type PageSnapshot = {
  title: string;
  description: string;
  url: string;
  headings: string[];
  links: Array<{ text: string; href: string }>;
  textSample: string;
};

@Injectable()
export class BrowserAutomationService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser): Promise<unknown> {
    return this.prisma.browserAutomationRun.findMany({
      where: { workspaceId: user.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { opportunity: { select: { id: true, title: true, score: true, status: true } } },
    });
  }

  async research(user: AuthenticatedUser, input: BrowserResearchDto): Promise<unknown> {
    const target = parsePublicUrl(input.targetUrl);
    if (input.opportunityId) await this.assertOpportunity(user, input.opportunityId);

    const run = await this.prisma.browserAutomationRun.create({
      data: {
        workspaceId: user.workspaceId,
        createdById: user.userId,
        opportunityId: input.opportunityId ?? null,
        kind: input.kind ?? 'MARKET_RESEARCH',
        status: 'QUEUED',
        provider: 'playwright.chromium',
        targetUrl: target.toString(),
        goal: input.goal.trim(),
        allowedActions: ALLOWED_RESEARCH_ACTIONS,
        blockedActions: BLOCKED_SENSITIVE_ACTIONS,
        steps: [],
      },
    });

    let browser: Browser | undefined;
    const steps: BrowserStep[] = [];
    const addStep = (action: string, status: BrowserStep['status'], detail: string) => {
      steps.push({ action, status, detail, at: new Date().toISOString() });
    };

    try {
      await this.prisma.browserAutomationRun.update({ where: { id: run.id }, data: { status: 'RUNNING', startedAt: new Date(), steps: steps as unknown as Prisma.InputJsonArray } });
      browser = await chromium.launch({ headless: true });
      addStep('launch_browser', 'OK', 'Chromium iniciado em contexto isolado.');
      const context = await browser.newContext({
        viewport: { width: 1365, height: 900 },
        locale: 'pt-BR',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      });
      const page = await context.newPage();
      const snapshot = await this.captureResearchPage(page, target.toString(), addStep);
      const result = buildResearchResult(input.goal, snapshot);
      if (input.opportunityId) await this.attachSignal(input.opportunityId, target.hostname, result);
      addStep('complete_research', 'OK', `Pesquisa concluida com ${snapshot.headings.length} headings e ${snapshot.links.length} links extraidos.`);

      return this.prisma.browserAutomationRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCEEDED',
          completedAt: new Date(),
          steps: steps as unknown as Prisma.InputJsonArray,
          result: result as unknown as Prisma.InputJsonObject,
        },
        include: { opportunity: { select: { id: true, title: true, score: true, status: true } } },
      });
    } catch (error) {
      addStep('fail_run', 'FAILED', safeErrorMessage(error));
      return this.prisma.browserAutomationRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          errorMessage: safeErrorMessage(error),
          steps: steps as unknown as Prisma.InputJsonArray,
        },
      });
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  async requireManualReview(user: AuthenticatedUser, input: BrowserResearchDto): Promise<unknown> {
    const target = parsePublicUrl(input.targetUrl);
    if (input.opportunityId) await this.assertOpportunity(user, input.opportunityId);
    return this.prisma.browserAutomationRun.create({
      data: {
        workspaceId: user.workspaceId,
        createdById: user.userId,
        opportunityId: input.opportunityId ?? null,
        kind: 'PRODUCT_SUBMISSION',
        status: 'REVIEW_REQUIRED',
        provider: 'playwright.chromium',
        targetUrl: target.toString(),
        goal: input.goal.trim(),
        allowedActions: ['navigate', 'prepare_draft'],
        blockedActions: BLOCKED_SENSITIVE_ACTIONS,
        steps: [{
          action: 'block_sensitive_action',
          status: 'BLOCKED',
          detail: 'Submissao/publicacao exige credenciais reais e aprovacao humana explicita antes de executar.',
          at: new Date().toISOString(),
        }],
      },
    });
  }

  private async captureResearchPage(page: Page, targetUrl: string, addStep: (action: string, status: BrowserStep['status'], detail: string) => void): Promise<PageSnapshot> {
    addStep('navigate', 'OK', `Abrindo ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load').catch(() => undefined);
    addStep('read_dom', 'OK', 'DOM carregado para extracao.');
    return page.evaluate((maxTextChars) => {
      const clean = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
      const headings = [...document.querySelectorAll('h1,h2,h3')]
        .map((node) => clean(node.textContent))
        .filter(Boolean)
        .slice(0, 20);
      const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
        .map((node) => ({ text: clean(node.textContent), href: node.href }))
        .filter((link) => link.text && link.href.startsWith('http'))
        .slice(0, 30);
      const description = clean(document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content);
      const textSample = clean(document.body?.innerText).slice(0, maxTextChars);
      return { title: clean(document.title), description, url: location.href, headings, links, textSample };
    }, MAX_TEXT_CHARS);
  }

  private async assertOpportunity(user: AuthenticatedUser, opportunityId: string): Promise<void> {
    const opportunity = await this.prisma.marketOpportunity.findFirst({ where: { id: opportunityId, workspaceId: user.workspaceId }, select: { id: true } });
    if (!opportunity) throw new NotFoundException('Opportunity not found');
  }

  private async attachSignal(opportunityId: string, hostname: string, result: Prisma.InputJsonObject): Promise<void> {
    const confidence = typeof result.confidence === 'number' ? result.confidence : 60;
    await this.prisma.opportunitySignal.create({
      data: {
        opportunityId,
        source: `browser:${hostname}`,
        label: typeof result.summary === 'string' ? result.summary.slice(0, 180) : 'Evidencia coletada por browser agent',
        strength: Math.max(35, Math.min(95, confidence)),
        url: typeof result.finalUrl === 'string' ? result.finalUrl : null,
        metadata: result,
      },
    });
  }
}

function parsePublicUrl(rawUrl: string): URL {
  const target = new URL(rawUrl);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new BadRequestException('Only HTTP(S) URLs are supported');
  const hostname = target.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname === '0.0.0.0' ||
    hostname.startsWith('127.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  ) {
    throw new ConflictException('Browser agents only navigate to public URLs.');
  }
  return target;
}

function buildResearchResult(goal: string, snapshot: PageSnapshot): Prisma.InputJsonObject {
  const matchedTerms = goal.toLowerCase().split(/\W+/).filter((term) => term.length > 3 && snapshot.textSample.toLowerCase().includes(term));
  const confidence = Math.min(95, 45 + snapshot.headings.length * 2 + snapshot.links.length + matchedTerms.length * 5);
  const summary = snapshot.description || snapshot.headings[0] || snapshot.title || 'Pagina analisada pelo browser agent';
  return {
    goal,
    finalUrl: snapshot.url,
    title: snapshot.title,
    summary,
    confidence,
    headings: snapshot.headings,
    links: snapshot.links,
    matchedTerms,
    textSample: snapshot.textSample,
  };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : 'Unknown browser automation failure';
}
