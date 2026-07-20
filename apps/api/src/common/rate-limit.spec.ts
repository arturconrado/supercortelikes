import { describe, expect, it } from 'vitest';
import { rateLimitKey, routeLimit } from './rate-limit';

describe('rate limit policy', () => {
  it('keeps login, registration, refresh and regular polling in independent buckets', () => {
    expect(rateLimitKey('/auth/login', '203.0.113.10')).toBe('203.0.113.10:auth-login');
    expect(rateLimitKey('/auth/register', '203.0.113.10')).toBe('203.0.113.10:auth-register');
    expect(rateLimitKey('/auth/refresh', '203.0.113.10')).toBe('203.0.113.10:auth-refresh');
    expect(rateLimitKey('/videos/id/pipeline', '203.0.113.10')).toBe('203.0.113.10:general');
  });

  it('allows frequent token refresh without weakening login protection', () => {
    expect(routeLimit('/auth/login', 'POST', 300)).toBe(20);
    expect(routeLimit('/auth/refresh', 'POST', 300)).toBe(120);
    expect(routeLimit('/videos/id/pipeline?live=1', 'GET', 300)).toBe(300);
  });
});
