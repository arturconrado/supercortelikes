import type { Plan } from '@prisma/client';

export const PLAN_VERSION = '2026-07-composition-1080p-v4';
export const GiB = 1024 ** 3;

export type CommercialPlan = Exclude<Plan, 'ENTERPRISE'>;

export interface PlanLimits {
  minutesPerMonth: number;
  maxUploadBytes: number;
  maxVideoDurationSeconds: number;
  exportResolution: '720p' | '1080p';
  /** Whether the platform forces its own watermark onto exports. */
  watermark: boolean;
  queuePriority: number;
  maxConcurrentHeavyJobs: number;
  graceDays: number;
}

export interface PublicPlan {
  id: CommercialPlan;
  name: string;
  price: number;
  currency: 'BRL';
  interval: 'month';
  recommended?: boolean;
  features: string[];
  version: string;
  limits: PlanLimits;
}

export const PLAN_LIMITS: Record<CommercialPlan, PlanLimits> = {
  FREE: {
    minutesPerMonth: 60,
    maxUploadBytes: 5 * GiB,
    maxVideoDurationSeconds: 60 * 60,
    exportResolution: '1080p',
    watermark: false,
    queuePriority: 20,
    maxConcurrentHeavyJobs: 1,
    graceDays: 0,
  },
  PRO: {
    minutesPerMonth: 600,
    maxUploadBytes: 5 * GiB,
    maxVideoDurationSeconds: 60 * 60,
    exportResolution: '1080p',
    watermark: false,
    queuePriority: 10,
    maxConcurrentHeavyJobs: 1,
    graceDays: 3,
  },
  BUSINESS: {
    minutesPerMonth: 2_000,
    maxUploadBytes: 5 * GiB,
    maxVideoDurationSeconds: 60 * 60,
    exportResolution: '1080p',
    watermark: false,
    queuePriority: 1,
    maxConcurrentHeavyJobs: 1,
    graceDays: 3,
  },
};

export const PUBLIC_PLANS: PublicPlan[] = [
  {
    id: 'FREE',
    name: 'Free',
    price: 0,
    currency: 'BRL',
    interval: 'month',
    version: PLAN_VERSION,
    limits: PLAN_LIMITS.FREE,
    features: ['60 minutos/mês', 'Uploads até 5 GiB', 'Exportação até 1080p', 'Sem marca d’água'],
  },
  {
    id: 'PRO',
    name: 'Pro',
    price: 59,
    currency: 'BRL',
    interval: 'month',
    recommended: true,
    version: PLAN_VERSION,
    limits: PLAN_LIMITS.PRO,
    features: ['600 minutos/mês', 'Uploads até 5 GiB', 'Exportação até 1080p', 'Sem marca d’água'],
  },
  {
    id: 'BUSINESS',
    name: 'Business',
    price: 149,
    currency: 'BRL',
    interval: 'month',
    version: PLAN_VERSION,
    limits: PLAN_LIMITS.BUSINESS,
    features: ['2.000 minutos/mês', 'Fila prioritária', 'Exportação até 1080p', 'Suporte prioritário'],
  },
];

export function commercialPlan(plan: Plan): CommercialPlan {
  return plan === 'ENTERPRISE' ? 'BUSINESS' : plan;
}

export function limitsFor(plan: Plan): PlanLimits {
  return PLAN_LIMITS[commercialPlan(plan)];
}
