ALTER TABLE "videos"
  ADD COLUMN "thumbnailKey" TEXT,
  ADD COLUMN "burnedInSubtitlesDetected" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "burnedInSubtitlesConfidence" DOUBLE PRECISION;

ALTER TABLE "clips"
  ADD COLUMN "thumbnailKey" TEXT;

ALTER TABLE "caption_tracks"
  ADD COLUMN "style" JSONB;
