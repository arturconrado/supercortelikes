import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, initials } from './utils';

describe('formatters', () => {
  it('formats storage sizes using binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5 GB');
  });

  it('formats short and long durations', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3661)).toBe('1:01:01');
  });

  it('creates initials without exposing the email', () => {
    expect(initials('Ana Maria Souza')).toBe('AM');
  });
});
