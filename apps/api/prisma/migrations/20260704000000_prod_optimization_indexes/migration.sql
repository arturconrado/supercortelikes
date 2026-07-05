-- Production hot-path indexes for library, pipeline snapshots, outbox relay and exports.
CREATE INDEX IF NOT EXISTS "videos_workspaceId_status_createdAt_idx" ON "videos"("workspaceId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "outbox_events_publishedAt_lockedAt_availableAt_createdAt_idx"
  ON "outbox_events"("publishedAt", "lockedAt", "availableAt", "createdAt");

CREATE INDEX IF NOT EXISTS "pipeline_runs_videoId_status_createdAt_idx" ON "pipeline_runs"("videoId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "pipeline_runs_status_currentStage_createdAt_idx" ON "pipeline_runs"("status", "currentStage", "createdAt");

CREATE INDEX IF NOT EXISTS "stage_executions_pipelineRunId_status_updatedAt_idx"
  ON "stage_executions"("pipelineRunId", "status", "updatedAt");

CREATE INDEX IF NOT EXISTS "dead_letter_jobs_pipelineRunId_status_createdAt_idx"
  ON "dead_letter_jobs"("pipelineRunId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "clips_videoId_status_createdAt_idx" ON "clips"("videoId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "exports_status_createdAt_idx" ON "exports"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "exports_status_updatedAt_idx" ON "exports"("status", "updatedAt");
