import './instrumentation';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { validateEnvironment } from './config/env';
import { Logger } from 'nestjs-pino';

const DEFAULT_MAX_VIDEO_BYTES = 5_368_709_120;
const MULTIPART_OVERHEAD_BYTES = 16 * 1024 * 1024;

async function bootstrap(): Promise<void> {
  const environment = validateEnvironment(process.env);
  const configuredLimit = environment.UPLOAD_MAX_BYTES;
  const maxVideoBytes = Number.isSafeInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : DEFAULT_MAX_VIDEO_BYTES;
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      bodyLimit: maxVideoBytes + MULTIPART_OVERHEAD_BYTES,
      requestTimeout: 0,
      keepAliveTimeout: 72_000,
      trustProxy: true,
    }),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: {
      fileSize: maxVideoBytes,
      files: 1,
      fields: 4,
      parts: 5,
      fieldNameSize: 100,
      fieldSize: 1024,
      headerPairs: 100,
    },
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    strictTransportSecurity:
      environment.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
  await app.register(rateLimit, {
    max: (request: { url: string; method: string }) => routeLimit(request.url, request.method, environment.RATE_LIMIT_MAX),
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
  });
  app.enableCors({
    origin: environment.CORS_ORIGINS,
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-project-id', 'x-requested-with'],
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.enableShutdownHooks();

  await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
}

void bootstrap();

function routeLimit(url: string, method: string, fallback: number): number {
  const path = url.split('?', 1)[0] ?? url;
  if (path.startsWith('/auth/login') || path.startsWith('/auth/register')) return 20;
  if (path.startsWith('/auth/password/forgot') || path.startsWith('/auth/email/verification')) return 10;
  if (path.startsWith('/billing/checkout')) return 30;
  if (path.startsWith('/api/mercado-pago/webhook')) return 600;
  if (path.startsWith('/videos/presigned-upload')) return 60;
  if (path.includes('/upload-parts')) return 180;
  if (method === 'DELETE' && path.startsWith('/videos/')) return 60;
  return fallback;
}
import './instrumentation';
