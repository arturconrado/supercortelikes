export type User = { id: string; name: string; email: string; avatarUrl?: string; role?: string; emailVerifiedAt?: string | null };
export type AuthResponse = { accessToken: string; refreshToken?: string; user: User };

export type Video = {
  id: string; originalFilename: string; title?: string; status: string; mimeType?: string; container?: string;
  sizeBytes?: string | number | null; durationSeconds?: number; thumbnailUrl?: string; playbackUrl?: string;
  createdAt: string; updatedAt?: string; progress?: number; clipsCount?: number; projectId?: string;
  processingStatus?: string; currentStage?: string | null;
  burnedInSubtitlesDetected?: boolean; burnedInSubtitlesConfidence?: number | null;
  processingOptions?: VideoProcessingOptions;
};

export type VideoProcessingOptions = {
  durationPreset: 'AUTO' | '15_30' | '30_60' | '60_90' | 'CUSTOM';
  minimumDurationSeconds: number;
  maximumDurationSeconds: number;
  clipCount: number;
  aspectRatio: '9:16' | '1:1' | '4:5' | '16:9';
  targetPlatform: 'AUTO' | 'TIKTOK' | 'INSTAGRAM_REELS' | 'YOUTUBE_SHORTS' | 'LINKEDIN' | 'YOUTUBE';
};

export type Project = {
  id: string; name: string; description?: string; status?: string; createdAt: string; updatedAt?: string;
  videosCount?: number; clipsCount?: number; thumbnailUrl?: string; videos?: Video[]; clips?: Clip[];
};

export type Clip = {
  id: string; projectId?: string; videoId?: string; title: string; reason?: string; status: string; score?: number;
  startSeconds?: number; endSeconds?: number; durationSeconds?: number; aspectRatio?: string; thumbnailUrl?: string;
  playbackUrl?: string; renderUrl?: string; downloadUrl?: string; captionsUrl?: string; createdAt?: string;
  description?: string; hashtags?: string[]; titleSuggestions?: Array<string | { title: string; score?: number }>;
  genre?: string; hook?: string; sourceText?: string; captionsEdited?: boolean;
  captions?: Array<{ id: string; template: string; language: string; cues: unknown[]; style?: Record<string, unknown> }>;
};

export type ExportJob = {
  id: string; clipId?: string; clipTitle?: string; format: string; status: string; progress?: number; sizeBytes?: number | string;
  aspectRatio?: string; downloadUrl?: string; createdAt: string; completedAt?: string; expiresAt?: string;
};

export type DashboardSummary = {
  videosProcessed?: number; clipsGenerated?: number; downloads?: number; processingMinutes?: number;
  storageBytes?: number | string; creditsUsed?: number; creditsLimit?: number; recentProjects?: Project[];
  recentVideos?: Video[]; activity?: AnalyticsPoint[];
};

export type AnalyticsPoint = { date: string; processings?: number; downloads?: number; minutes?: number; cost?: number };
export type Analytics = DashboardSummary & {
  period?: string; totalCost?: number; averageProcessingSeconds?: number; successRate?: number;
  byStatus?: Array<{ status: string; value: number }>;
};

export type PlanLimits = {
  minutesPerMonth: number;
  maxUploadBytes: number;
  maxVideoDurationSeconds: number;
  exportResolution: '720p' | '1080p';
  watermark: boolean;
  queuePriority: number;
  maxConcurrentHeavyJobs: number;
  graceDays: number;
};

export type UsageSnapshot = {
  plan: string;
  status: string;
  version: string;
  periodStart: string;
  periodEnd: string;
  graceUntil?: string;
  usage: { minutes: number; topUpMinutes?: number; limit: number; remaining: number };
  limits: PlanLimits;
};

export type Plan = { id: string; name: string; price: number; currency?: string; interval?: string; features: string[]; recommended?: boolean; version?: string; limits?: PlanLimits };
export type Subscription = {
  id?: string; plan: string; status: string; currentPeriodEnd?: string; cancelAtPeriodEnd?: boolean;
  usage?: UsageSnapshot; limits?: PlanLimits; graceUntil?: string; version?: string;
};
