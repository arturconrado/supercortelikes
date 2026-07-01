import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerAppModule } from './worker-app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  app.enableShutdownHooks();
  Logger.log('All eight media pipeline workers are ready', 'WorkerBootstrap');
}

void bootstrap();
import './instrumentation';
