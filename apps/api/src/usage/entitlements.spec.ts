import { describe, expect, it } from 'vitest';
import { PLAN_LIMITS, PUBLIC_PLANS } from './entitlements';

describe('plan entitlements', () => {
  it('never forces the PicaShorts watermark on an export', () => {
    expect(Object.values(PLAN_LIMITS).every((limits) => !limits.watermark)).toBe(true);
    expect(PUBLIC_PLANS.find((plan) => plan.id === 'FREE')?.features).toContain('Sem marca d’água');
  });
});
