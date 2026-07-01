import { describe, expect, it } from 'vitest';
import { normalizeVideoProcessingOptions } from './video-processing-options';

describe('normalizeVideoProcessingOptions', () => {
  it('keeps OpusClip-like defaults when no option is provided', () => {
    expect(normalizeVideoProcessingOptions()).toEqual({
      durationPreset: 'AUTO',
      minimumDurationSeconds: 15,
      maximumDurationSeconds: 90,
      clipCount: 20,
      aspectRatio: '9:16',
      targetPlatform: 'AUTO',
    });
  });

  it('maps presets and clamps generated clip count safely', () => {
    expect(normalizeVideoProcessingOptions({ durationPreset: '30_60', clipCount: 99, aspectRatio: '4:5' })).toEqual({
      durationPreset: '30_60',
      minimumDurationSeconds: 30,
      maximumDurationSeconds: 60,
      clipCount: 30,
      aspectRatio: '4:5',
      targetPlatform: 'INSTAGRAM_REELS',
    });
  });
});
