ALTER TABLE "exports" ADD COLUMN IF NOT EXISTS "renderFingerprint" TEXT;
ALTER TABLE "exports" ADD COLUMN IF NOT EXISTS "sourcePipelineRunId" UUID;

CREATE INDEX IF NOT EXISTS "exports_clipId_renderFingerprint_status_idx"
  ON "exports"("clipId", "renderFingerprint", "status");
