ALTER TABLE "videos"
  ADD COLUMN "audioPresent" BOOLEAN,
  ADD COLUMN "speechDetected" BOOLEAN,
  ADD COLUMN "processingMode" TEXT,
  ADD COLUMN "speakerCount" INTEGER;

CREATE INDEX "videos_processingMode_status_createdAt_idx"
  ON "videos"("processingMode", "status", "createdAt");
