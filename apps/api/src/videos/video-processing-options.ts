export const CLIP_DURATION_PRESETS = ['AUTO', '15_30', '30_60', '60_90', 'CUSTOM'] as const;
export const CLIP_ASPECT_RATIOS = ['9:16', '1:1', '4:5', '16:9'] as const;
export const CLIP_TARGET_PLATFORMS = ['AUTO', 'TIKTOK', 'INSTAGRAM_REELS', 'YOUTUBE_SHORTS', 'LINKEDIN', 'YOUTUBE'] as const;

export type ClipDurationPreset = (typeof CLIP_DURATION_PRESETS)[number];
export type ClipAspectRatio = (typeof CLIP_ASPECT_RATIOS)[number];
export type ClipTargetPlatform = (typeof CLIP_TARGET_PLATFORMS)[number];

export type VideoProcessingOptionsInput = {
  durationPreset?: ClipDurationPreset;
  minimumDurationSeconds?: number;
  maximumDurationSeconds?: number;
  clipCount?: number;
  aspectRatio?: ClipAspectRatio;
  targetPlatform?: ClipTargetPlatform;
};

export type VideoProcessingOptions = {
  durationPreset: ClipDurationPreset;
  minimumDurationSeconds: number;
  maximumDurationSeconds: number;
  clipCount: number;
  aspectRatio: ClipAspectRatio;
  targetPlatform: ClipTargetPlatform;
};

export const DEFAULT_VIDEO_PROCESSING_OPTIONS: VideoProcessingOptions = {
  durationPreset: 'AUTO',
  minimumDurationSeconds: 15,
  maximumDurationSeconds: 90,
  clipCount: 20,
  aspectRatio: '9:16',
  targetPlatform: 'AUTO',
};

const durationByPreset: Record<Exclude<ClipDurationPreset, 'CUSTOM'>, Pick<VideoProcessingOptions, 'minimumDurationSeconds' | 'maximumDurationSeconds'>> = {
  AUTO: { minimumDurationSeconds: 15, maximumDurationSeconds: 90 },
  '15_30': { minimumDurationSeconds: 15, maximumDurationSeconds: 30 },
  '30_60': { minimumDurationSeconds: 30, maximumDurationSeconds: 60 },
  '60_90': { minimumDurationSeconds: 60, maximumDurationSeconds: 90 },
};

export function normalizeVideoProcessingOptions(input?: VideoProcessingOptionsInput | null): VideoProcessingOptions {
  const preset = CLIP_DURATION_PRESETS.includes(input?.durationPreset as ClipDurationPreset)
    ? input!.durationPreset!
    : DEFAULT_VIDEO_PROCESSING_OPTIONS.durationPreset;
  const presetDurations = preset === 'CUSTOM'
    ? undefined
    : durationByPreset[preset];
  const minimumDurationSeconds = clampInteger(
    presetDurations?.minimumDurationSeconds ?? input?.minimumDurationSeconds,
    5,
    180,
    DEFAULT_VIDEO_PROCESSING_OPTIONS.minimumDurationSeconds,
  );
  const maximumDurationSeconds = Math.max(
    minimumDurationSeconds,
    clampInteger(
      presetDurations?.maximumDurationSeconds ?? input?.maximumDurationSeconds,
      5,
      240,
      DEFAULT_VIDEO_PROCESSING_OPTIONS.maximumDurationSeconds,
    ),
  );
  return {
    durationPreset: preset,
    minimumDurationSeconds,
    maximumDurationSeconds,
    clipCount: clampInteger(input?.clipCount, 1, 30, DEFAULT_VIDEO_PROCESSING_OPTIONS.clipCount),
    aspectRatio: CLIP_ASPECT_RATIOS.includes(input?.aspectRatio as ClipAspectRatio)
      ? input!.aspectRatio!
      : DEFAULT_VIDEO_PROCESSING_OPTIONS.aspectRatio,
    targetPlatform: CLIP_TARGET_PLATFORMS.includes(input?.targetPlatform as ClipTargetPlatform)
      ? input!.targetPlatform!
      : defaultPlatformForAspectRatio(input?.aspectRatio),
  };
}

function defaultPlatformForAspectRatio(aspectRatio: unknown): ClipTargetPlatform {
  if (aspectRatio === '16:9') return 'YOUTUBE';
  if (aspectRatio === '4:5') return 'INSTAGRAM_REELS';
  return DEFAULT_VIDEO_PROCESSING_OPTIONS.targetPlatform;
}

function clampInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}
