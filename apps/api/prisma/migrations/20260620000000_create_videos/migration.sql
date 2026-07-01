CREATE TYPE "VideoStatus" AS ENUM ('UPLOADING', 'UPLOADED', 'FAILED');
CREATE TYPE "UploadStatus" AS ENUM ('STARTED', 'COMPLETED', 'FAILED');

CREATE TABLE "videos" (
    "id" UUID NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "storageBucket" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "container" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "checksumSha256" TEXT,
    "storageEtag" TEXT,
    "status" "VideoStatus" NOT NULL DEFAULT 'UPLOADING',
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "videos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "videos_storageKey_key" ON "videos"("storageKey");
CREATE INDEX "videos_status_createdAt_idx" ON "videos"("status", "createdAt");

CREATE TABLE "upload_attempts" (
    "id" UUID NOT NULL,
    "videoId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "status" "UploadStatus" NOT NULL DEFAULT 'STARTED',
    "bytesReceived" BIGINT NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "upload_attempts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "aggregateId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "upload_attempts_idempotencyKey_key" ON "upload_attempts"("idempotencyKey");
CREATE INDEX "upload_attempts_status_startedAt_idx" ON "upload_attempts"("status", "startedAt");
CREATE INDEX "outbox_events_publishedAt_createdAt_idx" ON "outbox_events"("publishedAt", "createdAt");
ALTER TABLE "upload_attempts" ADD CONSTRAINT "upload_attempts_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
