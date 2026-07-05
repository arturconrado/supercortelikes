import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './env';

const base = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/clipbr',
  JWT_SECRET: '12345678901234567890123456789012',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'clipbr-videos',
  S3_ACCESS_KEY_ID: 'access',
  S3_SECRET_ACCESS_KEY: 'secret',
  REDIS_URL: 'redis://localhost:6379',
};

describe('environment validation', () => {
  it('keeps rollout aliases working for local development', () => {
    const config = validateEnvironment({ ...base, CORS_ORIGIN: 'http://localhost:3000', MAX_UPLOAD_SIZE_BYTES: '1024' });
    expect(config).toMatchObject({ APP_ENV: 'local', S3_ACCESS_KEY: 'access', S3_SECRET_KEY: 'secret', UPLOAD_MAX_BYTES: 1024 });
    expect(config.DIRECT_DATABASE_URL).toBe(base.DATABASE_URL);
    expect(config.REFRESH_TOKEN_SECRET).toBe(base.JWT_SECRET);
  });

  it('fails closed in production without direct database, refresh pepper, AI and direct upload', () => {
    expect(() => validateEnvironment({ ...base, NODE_ENV: 'production', APP_ENV: 'production' })).toThrow();
  });

  it('accepts a complete production configuration and the Render SHA alias', () => {
    const config = validateEnvironment({
      ...base,
      NODE_ENV: 'production', APP_ENV: 'production', DIRECT_DATABASE_URL: base.DATABASE_URL,
      REFRESH_TOKEN_SECRET: 'abcdefghijklmnopqrstuvwxyz123456', ENABLE_AI: 'true', ENABLE_WHISPERX: 'true',
      UPLOAD_MODE: 'direct', RENDER_GIT_COMMIT: 'abcdef1234',
    });
    expect(config).toMatchObject({
      APP_ENV: 'production',
      UPLOAD_MODE: 'direct',
      ENABLE_AI: true,
      BUILD_SHA: 'abcdef1234',
      OUTBOX_BATCH_SIZE: 50,
      FFMPEG_PRESET: 'veryfast',
      FFMPEG_CRF: 22,
      YTDLP_FRAGMENT_CONCURRENCY: 4,
      MEDIA_HEAVY_CONCURRENT_JOBS: 2,
      MEDIA_LIGHT_CONCURRENT_JOBS: 4,
    });
  });

  it('rejects Turnstile bypass tokens in production by default', () => {
    expect(() => validateEnvironment({
      ...base,
      NODE_ENV: 'production', APP_ENV: 'production', DIRECT_DATABASE_URL: base.DATABASE_URL,
      REFRESH_TOKEN_SECRET: 'abcdefghijklmnopqrstuvwxyz123456', ENABLE_AI: 'true', ENABLE_WHISPERX: 'true',
      UPLOAD_MODE: 'direct', TURNSTILE_BYPASS_TOKEN: 'internal-smoke-bypass',
    })).toThrow(/TURNSTILE_BYPASS_TOKEN/);
  });
});
