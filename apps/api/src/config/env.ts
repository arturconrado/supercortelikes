import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalSecret = z.preprocess((value) => (value === '' ? undefined : value), z.string().min(1).optional());
const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.string().url().optional());
const pipelineConcurrencyDefault =
  '{"ingestion":4,"transcription":2,"segmentation":3,"scoring":4,"clips":3,"captions":3,"rendering":2,"exports":3}';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'test', 'release', 'production']).default('local'),
  PORT: z.coerce.number().int().positive().max(65_535).default(3001),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),
  RATE_LIMIT_MAX: z.coerce.number().int().min(10).max(10_000).default(300),
  DATABASE_URL: z.string().min(1),
  DIRECT_DATABASE_URL: optionalSecret,
  JWT_SECRET: z.string().min(32),
  REFRESH_TOKEN_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:3001'),
  TERMS_VERSION: z.string().min(1).default('terms-2026-06'),
  PRIVACY_VERSION: z.string().min(1).default('privacy-2026-06'),
  EMAIL_VERIFICATION_REQUIRED: booleanString,
  TURNSTILE_REQUIRED: booleanString,
  TURNSTILE_SECRET_KEY: optionalSecret,
  TURNSTILE_BYPASS_TOKEN: optionalSecret,
  ALLOW_TURNSTILE_BYPASS_IN_PRODUCTION: booleanString,
  MERCADO_PAGO_ACCESS_TOKEN: optionalSecret,
  MERCADO_PAGO_WEBHOOK_SECRET: z.preprocess((value) => (value === '' ? undefined : value), z.string().min(16).optional()),
  RESEND_API_KEY: optionalSecret,
  EMAIL_FROM: z.string().email().default('noreply@picashorts.com'),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: optionalUrl,
  S3_PUBLIC_BASE_URL: optionalUrl,
  S3_REGION: z.string().min(1).default('auto'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(3),
  S3_FORCE_PATH_STYLE: booleanString,
  REDIS_URL: z.string().url(),
  QUEUE_PREFIX: z.string().regex(/^[A-Za-z0-9_-]+$/).default('picashorts'),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(50),
  PIPELINE_STAGE_CONCURRENCY_JSON: z.string().default(pipelineConcurrencyDefault),
  PIPELINE_EVENT_RETENTION_SECONDS: z.coerce.number().int().min(30).max(86_400).default(300),
  ANALYTICS_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(3_600).default(30),
  MEDIA_WORKER_URL: z.string().url().default('http://localhost:8000'),
  MEDIA_WORKER_TOKEN: optionalSecret,
  MEDIA_WORKER_DATA_DIR: z.string().default('/data'),
  MEDIA_WORKER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(8 * 60 * 60 * 1000).default(7_200_000),
  MEDIA_DIARIZATION_ENABLED: booleanString,
  MEDIA_TRANSCRIPTION_BATCH_SIZE: z.coerce.number().int().min(1).max(64).default(16),
  MEDIA_HEAVY_CONCURRENT_JOBS: z.coerce.number().int().min(1).max(8).default(2),
  MEDIA_LIGHT_CONCURRENT_JOBS: z.coerce.number().int().min(1).max(16).default(4),
  FFMPEG_PRESET: z
    .enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'])
    .default('veryfast'),
  FFMPEG_CRF: z.coerce.number().int().min(16).max(35).default(22),
  FFMPEG_THREADS: z.coerce.number().int().min(1).max(32).default(2),
  FFMPEG_FILTER_THREADS: z.coerce.number().int().min(1).max(16).default(1),
  RENDER_MAX_HEIGHT: z.coerce.number().int().min(360).max(2160).default(720),
  ALLOW_FULL_BATCH_RENDER: booleanString,
  YTDLP_FRAGMENT_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  ENABLE_AI: booleanString,
  ENABLE_WHISPERX: booleanString,
  ENABLE_OPENCV: booleanString,
  ENABLE_MEDIAPIPE: booleanString,
  ENABLE_YOLO: booleanString,
  LLM_PROVIDER: z.enum(['none', 'openai', 'openrouter']).default('none'),
  LLM_API_KEY: optionalSecret,
  LLM_MODEL: optionalSecret,
  MEDIA_MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).max(8).default(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  OTEL_SERVICE_NAME: z.string().default('picashorts-api'),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(5_368_709_120),
  UPLOAD_ALLOWED_MIME_TYPES: z
    .string()
    .default('video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo')
    .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean)),
  UPLOAD_MODE: z.enum(['stream', 'direct']).default('stream'),
  UPLOAD_PART_SIZE_BYTES: z.coerce.number().int().min(5 * 1024 * 1024).default(64 * 1024 * 1024),
  UPLOAD_QUEUE_SIZE: z.coerce.number().int().min(1).max(8).default(2),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  BUILD_SHA: z.string().max(64).default('development'),
}).superRefine((value, context) => {
  if (value.APP_ENV === 'release' || value.APP_ENV === 'production') {
    if (!value.DIRECT_DATABASE_URL) {
      context.addIssue({ code: 'custom', path: ['DIRECT_DATABASE_URL'], message: 'DIRECT_DATABASE_URL is required' });
    }
    if (!value.ENABLE_AI || !value.ENABLE_WHISPERX) {
      context.addIssue({ code: 'custom', path: ['ENABLE_AI'], message: 'AI and WhisperX must be enabled' });
    }
    if (value.UPLOAD_MODE !== 'direct') {
      context.addIssue({ code: 'custom', path: ['UPLOAD_MODE'], message: 'Direct upload is required' });
    }
    if (value.EMAIL_VERIFICATION_REQUIRED && !value.RESEND_API_KEY) {
      context.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'RESEND_API_KEY is required when email verification is enforced' });
    }
    if (value.TURNSTILE_REQUIRED && !value.TURNSTILE_SECRET_KEY) {
      context.addIssue({ code: 'custom', path: ['TURNSTILE_SECRET_KEY'], message: 'TURNSTILE_SECRET_KEY is required when Turnstile is enforced' });
    }
    if (value.APP_ENV === 'production' && value.TURNSTILE_BYPASS_TOKEN && !value.ALLOW_TURNSTILE_BYPASS_IN_PRODUCTION) {
      context.addIssue({ code: 'custom', path: ['TURNSTILE_BYPASS_TOKEN'], message: 'TURNSTILE_BYPASS_TOKEN cannot be enabled in production' });
    }
    if (value.LLM_PROVIDER !== 'none' && !value.LLM_API_KEY) {
      context.addIssue({ code: 'custom', path: ['LLM_API_KEY'], message: 'LLM_API_KEY is required when LLM_PROVIDER is enabled' });
    }
  }
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(config: Record<string, unknown>): Environment {
  const appEnv = config.APP_ENV ?? (config.NODE_ENV === 'test' ? 'test' : config.NODE_ENV === 'production' ? 'production' : 'local');
  const local = appEnv === 'local' || appEnv === 'test';
  return environmentSchema.parse({
    ...config,
    APP_ENV: appEnv,
    DIRECT_DATABASE_URL: config.DIRECT_DATABASE_URL ?? (local ? config.DATABASE_URL : undefined),
    REFRESH_TOKEN_SECRET: config.REFRESH_TOKEN_SECRET ?? (local ? config.JWT_SECRET : undefined),
    CORS_ORIGINS: config.CORS_ORIGINS ?? config.CORS_ORIGIN,
    S3_ACCESS_KEY: config.S3_ACCESS_KEY_ID ?? config.S3_ACCESS_KEY,
    S3_SECRET_KEY: config.S3_SECRET_ACCESS_KEY ?? config.S3_SECRET_KEY,
    S3_PUBLIC_BASE_URL: config.S3_PUBLIC_BASE_URL,
    UPLOAD_MAX_BYTES: config.MAX_UPLOAD_SIZE_BYTES ?? config.UPLOAD_MAX_BYTES,
    BUILD_SHA: config.BUILD_SHA ?? config.RENDER_GIT_COMMIT,
  });
}
