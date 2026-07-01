CREATE TYPE "PipelineStage" AS ENUM ('INGESTION', 'TRANSCRIPTION', 'SEGMENTATION', 'SCORING', 'CLIPS', 'CAPTIONS', 'RENDERING', 'EXPORTS');
CREATE TYPE "PipelineRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "StageExecutionStatus" AS ENUM ('PENDING', 'QUEUED', 'PROCESSING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTERED');
CREATE TYPE "DeadLetterStatus" AS ENUM ('OPEN', 'REDRIVEN', 'DISCARDED');

ALTER TABLE "outbox_events"
  ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lockedAt" TIMESTAMP(3),
  ADD COLUMN "lockedBy" TEXT,
  ADD COLUMN "lastError" TEXT;

DROP INDEX "outbox_events_publishedAt_createdAt_idx";
CREATE INDEX "outbox_events_publishedAt_availableAt_createdAt_idx" ON "outbox_events"("publishedAt", "availableAt", "createdAt");

CREATE TABLE "pipeline_runs" (
  "id" UUID NOT NULL,
  "videoId" UUID NOT NULL,
  "sourceEventId" UUID NOT NULL,
  "status" "PipelineRunStatus" NOT NULL DEFAULT 'PENDING',
  "currentStage" "PipelineStage",
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pipeline_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stage_executions" (
  "id" UUID NOT NULL,
  "pipelineRunId" UUID NOT NULL,
  "stage" "PipelineStage" NOT NULL,
  "status" "StageExecutionStatus" NOT NULL DEFAULT 'PENDING',
  "jobId" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stage_executions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "dead_letter_jobs" (
  "id" UUID NOT NULL,
  "pipelineRunId" UUID,
  "stageExecutionId" UUID,
  "originalQueue" TEXT NOT NULL,
  "originalJobId" TEXT NOT NULL,
  "safePayload" JSONB NOT NULL,
  "errorCode" TEXT NOT NULL,
  "errorMessage" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL,
  "status" "DeadLetterStatus" NOT NULL DEFAULT 'OPEN',
  "redriveCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "dead_letter_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pipeline_runs_sourceEventId_key" ON "pipeline_runs"("sourceEventId");
CREATE INDEX "pipeline_runs_status_createdAt_idx" ON "pipeline_runs"("status", "createdAt");
CREATE INDEX "pipeline_runs_videoId_createdAt_idx" ON "pipeline_runs"("videoId", "createdAt");
CREATE UNIQUE INDEX "stage_executions_jobId_key" ON "stage_executions"("jobId");
CREATE UNIQUE INDEX "stage_executions_pipelineRunId_stage_key" ON "stage_executions"("pipelineRunId", "stage");
CREATE INDEX "stage_executions_status_updatedAt_idx" ON "stage_executions"("status", "updatedAt");
CREATE UNIQUE INDEX "dead_letter_jobs_originalQueue_originalJobId_key" ON "dead_letter_jobs"("originalQueue", "originalJobId");
CREATE INDEX "dead_letter_jobs_status_createdAt_idx" ON "dead_letter_jobs"("status", "createdAt");

ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stage_executions" ADD CONSTRAINT "stage_executions_pipelineRunId_fkey" FOREIGN KEY ("pipelineRunId") REFERENCES "pipeline_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dead_letter_jobs" ADD CONSTRAINT "dead_letter_jobs_pipelineRunId_fkey" FOREIGN KEY ("pipelineRunId") REFERENCES "pipeline_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "dead_letter_jobs" ADD CONSTRAINT "dead_letter_jobs_stageExecutionId_fkey" FOREIGN KEY ("stageExecutionId") REFERENCES "stage_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
