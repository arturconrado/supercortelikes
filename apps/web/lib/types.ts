export type User = { id: string; name: string; email: string; avatarUrl?: string; role?: string; emailVerifiedAt?: string | null };
export type AuthResponse = { accessToken: string; refreshToken?: string; user: User };

export type Video = {
  id: string; originalFilename: string; title?: string; status: string; mimeType?: string; container?: string;
  sizeBytes?: string | number | null; durationSeconds?: number; thumbnailUrl?: string; playbackUrl?: string;
  createdAt: string; updatedAt?: string; progress?: number; clipsCount?: number; projectId?: string;
  processingStatus?: string; currentStage?: string | null;
  burnedInSubtitlesDetected?: boolean; burnedInSubtitlesConfidence?: number | null;
  audioPresent?: boolean | null; speechDetected?: boolean | null; processingMode?: 'speech' | 'visual' | string | null; speakerCount?: number | null;
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
  playbackUrl?: string; previewUrl?: string; previewStatus?: string; renderUrl?: string; downloadUrl?: string; captionsUrl?: string; createdAt?: string;
  composition?: { version: string; plan?: Record<string, unknown>; diagnostics?: Record<string, unknown> } | null;
  quality?: {
    status: 'PASSED' | 'UNVERIFIED' | 'REVIEW_REQUIRED';
    issues: string[];
    confidence: number;
    attempts: number;
    model?: string | null;
    reviewedAt?: string | null;
    verified: boolean;
    reasons?: string[];
  };
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
  storageBytes?: number | string; creditsUsed?: number; creditsReserved?: number; creditsLimit?: number; recentProjects?: Project[];
  recentVideos?: Video[]; activity?: AnalyticsPoint[];
};

export type AnalyticsPoint = { date: string; processings?: number; downloads?: number; minutes?: number; cost?: number };
export type Analytics = DashboardSummary & {
  period?: string; totalCost?: number; averageProcessingSeconds?: number; successRate?: number;
  byStatus?: Array<{ status: string; value: number }>;
};

export type OpportunitySignal = {
  id: string;
  source: string;
  label: string;
  strength: number;
  url?: string | null;
  capturedAt?: string;
};

export type DigitalProduct = {
  id: string;
  opportunityId: string;
  title: string;
  format: string;
  offerType: 'PRODUCT' | 'SERVICE' | 'HYBRID';
  status: 'DRAFT' | 'QA_REQUIRED' | 'READY' | 'ARCHIVED';
  priceCents: number;
  qualityScore: number;
  outline: {
    promise?: string;
    modules?: Array<{ title: string; items: string[] }>;
    deliverables?: string[];
  };
  serviceBlueprint?: {
    serviceName?: string;
    deliveryModel?: string;
    steps?: string[];
    boundaries?: string[];
  } | null;
  mediaPlan: {
    objective?: string;
    channels?: Array<{ kind: string; count: number; purpose: string; brief: string }>;
    humanGate?: string[];
  };
  assets: {
    salesPage?: string;
    coverBrief?: string;
    staticImages?: string[];
    carousels?: string[][];
    shortVideos?: string[];
    audioScripts?: string[];
    emailSequence?: string[];
    creativeAngles?: string[];
    submissionChecklist?: string[];
  };
  qaFindings: string[];
  createdAt: string;
  updatedAt: string;
  opportunity?: Pick<MarketOpportunity, 'id' | 'title' | 'status' | 'score'>;
  mediaAssets?: OfferMediaAsset[];
  publicationDrafts?: OfferPublicationDraft[];
  launchRuns?: OfferLaunchRun[];
};

export type OfferLaunchRun = {
  id: string;
  status: 'DRAFT' | 'READY' | 'RUNNING' | 'REVIEW_REQUIRED' | 'COMPLETED' | 'FAILED';
  mode: string;
  steps: Array<{ name: string; status: string; detail: string }>;
  stages?: OfferProductionStageExecution[];
  result?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type OfferProductionStageExecution = {
  id: string;
  stage: 'OFFER' | 'MEDIA_ASSETS' | 'PUBLICATION_DRAFTS' | 'METRICS_SETUP';
  status: 'PENDING' | 'QUEUED' | 'PROCESSING' | 'RETRYING' | 'SUCCEEDED' | 'FAILED' | 'DEAD_LETTERED';
  attempts: number;
  output?: unknown;
};

export type OfferPublicationDraft = {
  id: string;
  provider: string;
  channel: string;
  status: 'DRAFT' | 'READY' | 'APPROVED' | 'SCHEDULED' | 'PUBLISHED' | 'FAILED';
  title: string;
  body: Record<string, unknown>;
  scheduledAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OfferMediaAsset = {
  id: string;
  productId: string;
  kind:
    | 'LANDING_PAGE'
    | 'STATIC_IMAGE'
    | 'CAROUSEL'
    | 'SHORT_VIDEO'
    | 'AUDIO_SCRIPT'
    | 'WHATSAPP_COPY'
    | 'EMAIL'
    | 'DIAGNOSTIC_FORM'
    | 'PROPOSAL_PDF'
    | 'SERVICE_ONEPAGER'
    | 'CHECKOUT_COPY';
  status: 'DRAFT' | 'READY' | 'REVIEW_REQUIRED' | 'APPROVED' | 'ARCHIVED';
  title: string;
  channel: string;
  objective: string;
  brief: string;
  body: Record<string, unknown>;
  qaChecklist: string[];
  createdAt: string;
  updatedAt: string;
};

export type MarketOpportunity = {
  id: string;
  title: string;
  audience: string;
  pain: string;
  category: string;
  format: string;
  offerType: 'PRODUCT' | 'SERVICE' | 'HYBRID';
  status: 'OBSERVING' | 'TESTING' | 'ACTIVE' | 'SCALING' | 'DECLINING' | 'MIGRATING' | 'DEAD';
  gateDecision: 'PENDING' | 'APPROVED' | 'REJECTED';
  score: number;
  demandScore: number;
  saturationScore: number;
  monetizationScore: number;
  channelFitScore: number;
  evidenceSummary: string;
  agentRationale: string;
  nextAction: string;
  sourceTags: string[];
  recommendedMedia: {
    offerType: 'PRODUCT' | 'SERVICE' | 'HYBRID';
    primaryFormat: string;
    required: string[];
    optional: string[];
  };
  createdAt: string;
  updatedAt: string;
  approvedAt?: string | null;
  rejectedAt?: string | null;
  signals?: OpportunitySignal[];
  products?: DigitalProduct[];
};

export type OpportunityCockpit = {
  limits: { maxTesting: number; maxActive: number };
  counts: { total: number; testing: number; active: number; approved: number; products: number };
  byStatus: Record<string, number>;
  opportunities: MarketOpportunity[];
  products: DigitalProduct[];
};

export type BrowserAutomationRun = {
  id: string;
  opportunityId?: string | null;
  kind: 'MARKET_RESEARCH' | 'PRODUCT_SUBMISSION' | 'CONTENT_SCHEDULING' | 'COMPETITOR_REVIEW' | 'CUSTOM';
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'REVIEW_REQUIRED' | 'CANCELLED';
  provider: string;
  targetUrl: string;
  goal: string;
  allowedActions: string[];
  blockedActions: string[];
  steps: Array<{ action: string; status: string; detail: string; at: string }>;
  result?: {
    title?: string;
    summary?: string;
    confidence?: number;
    finalUrl?: string;
    headings?: string[];
    matchedTerms?: string[];
  } | null;
  errorMessage?: string | null;
  createdAt: string;
  completedAt?: string | null;
  opportunity?: Pick<MarketOpportunity, 'id' | 'title' | 'status' | 'score'>;
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
