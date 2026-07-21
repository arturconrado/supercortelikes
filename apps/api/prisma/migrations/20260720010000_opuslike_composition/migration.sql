ALTER TYPE "PipelineStage" ADD VALUE IF NOT EXISTS 'COMPOSITION';

CREATE TYPE "ExportPurpose" AS ENUM ('PREVIEW', 'FINAL');

ALTER TABLE "exports"
ADD COLUMN "purpose" "ExportPurpose" NOT NULL DEFAULT 'FINAL';

CREATE TABLE "clip_compositions" (
    "id" UUID NOT NULL,
    "clipId" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "diagnostics" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clip_compositions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "clip_compositions_clipId_key" ON "clip_compositions"("clipId");
CREATE INDEX "exports_clipId_purpose_status_idx" ON "exports"("clipId", "purpose", "status");

ALTER TABLE "clip_compositions"
ADD CONSTRAINT "clip_compositions_clipId_fkey"
FOREIGN KEY ("clipId") REFERENCES "clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
