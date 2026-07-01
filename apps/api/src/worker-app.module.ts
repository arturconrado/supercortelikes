import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/env';
import { DatabaseModule } from './database/database.module';
import { MediaModule } from './media/media.module';
import { QueuesModule } from './queues/queues.module';
import { WorkerHeartbeatService } from './queues/worker-heartbeat.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['../../.env', '.env'],
      validate: validateEnvironment,
    }),
    DatabaseModule,
    QueuesModule,
    MediaModule,
  ],
  providers: [WorkerHeartbeatService],
})
export class WorkerAppModule {}
