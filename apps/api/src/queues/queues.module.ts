import { Global, Module } from '@nestjs/common';
import { UsageModule } from '../usage/usage.module';
import { DeadLetterService } from './dead-letter.service';
import { OutboxRelayService } from './outbox-relay.service';
import { PipelineOrchestratorService } from './pipeline-orchestrator.service';
import { QueueRegistryService } from './queue-registry.service';
import { StageWorkerFactory } from './stage-worker.factory';

@Global()
@Module({
  imports: [UsageModule],
  providers: [QueueRegistryService, DeadLetterService, PipelineOrchestratorService, OutboxRelayService, StageWorkerFactory],
  exports: [QueueRegistryService, DeadLetterService, PipelineOrchestratorService, OutboxRelayService, StageWorkerFactory],
})
export class QueuesModule {}
