import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/env';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { QueuesModule } from './queues/queues.module';
import { VideosModule } from './videos/videos.module';
import { ProjectsModule } from './projects/projects.module';
import { ContentModule } from './content/content.module';
import { BillingModule } from './billing/billing.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AccountModule } from './account/account.module';
import { ExportsModule } from './exports/exports.module';
import { SettingsModule } from './settings/settings.module';
import { LoggerModule } from 'nestjs-pino';
import { ObservabilityModule } from './observability/observability.module';
import { UsageModule } from './usage/usage.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PublicationsModule } from './publications/publications.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['../../.env', '.env'],
      validate: validateEnvironment,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
        redact: {
          paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie', '*.password', '*.token'],
          censor: '[REDACTED]',
        },
        autoLogging: { ignore: (request) => request.url === '/health/live' || request.url === '/metrics' },
      },
    }),
    DatabaseModule,
    AuthModule,
    QueuesModule,
    HealthModule,
    ProjectsModule,
    ContentModule,
    BillingModule,
    AnalyticsModule,
    AccountModule,
    ExportsModule,
    SettingsModule,
    ObservabilityModule,
    NotificationsModule,
    PublicationsModule,
    UsageModule,
    VideosModule,
  ],
})
export class AppModule {}
