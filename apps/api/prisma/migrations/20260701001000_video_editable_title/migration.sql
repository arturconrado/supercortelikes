-- Editable display title for videos. Backfilled from the sanitized original filename
-- so existing imported/uploaded videos keep a visible name everywhere.
ALTER TABLE "videos"
ADD COLUMN "title" TEXT;

UPDATE "videos"
SET "title" = "originalFilename"
WHERE "title" IS NULL;
