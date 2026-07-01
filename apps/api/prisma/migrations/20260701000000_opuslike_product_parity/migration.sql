-- Extend workspace roles for the Opus-like review/publish workflow.
ALTER TYPE "WorkspaceRole" ADD VALUE IF NOT EXISTS 'REVIEWER';
ALTER TYPE "WorkspaceRole" ADD VALUE IF NOT EXISTS 'PUBLISHER';

-- Clip intelligence and editable caption metadata.
ALTER TABLE "clips"
ADD COLUMN "genre" TEXT,
ADD COLUMN "hook" TEXT,
ADD COLUMN "sourceText" TEXT;

ALTER TABLE "caption_tracks"
ADD COLUMN "editedCues" JSONB;

-- Commercial minute top-ups.
CREATE TABLE "credit_top_ups" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "minutes" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "provider" TEXT NOT NULL DEFAULT 'mercado_pago',
    "providerResourceId" TEXT,
    "status" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_top_ups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "credit_top_ups_idempotencyKey_key" ON "credit_top_ups"("idempotencyKey");
CREATE UNIQUE INDEX "credit_top_ups_providerResourceId_key" ON "credit_top_ups"("providerResourceId");
CREATE INDEX "credit_top_ups_workspaceId_createdAt_idx" ON "credit_top_ups"("workspaceId", "createdAt");
CREATE INDEX "credit_top_ups_status_createdAt_idx" ON "credit_top_ups"("status", "createdAt");

ALTER TABLE "credit_top_ups"
ADD CONSTRAINT "credit_top_ups_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Social publication scheduling/contracts. Provider tokens are never stored in plaintext.
CREATE TABLE "publications" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "clipId" UUID,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "title" TEXT NOT NULL,
    "description" TEXT,
    "hashtags" JSONB,
    "providerPostId" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "publications_workspaceId_scheduledAt_idx" ON "publications"("workspaceId", "scheduledAt");
CREATE INDEX "publications_provider_status_idx" ON "publications"("provider", "status");

ALTER TABLE "publications"
ADD CONSTRAINT "publications_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "publications"
ADD CONSTRAINT "publications_clipId_fkey"
FOREIGN KEY ("clipId") REFERENCES "clips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "social_connections" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "accessTokenHash" TEXT,
    "refreshTokenHash" TEXT,
    "scopes" JSONB,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "social_connections_workspaceId_provider_key" ON "social_connections"("workspaceId", "provider");
CREATE INDEX "social_connections_workspaceId_status_idx" ON "social_connections"("workspaceId", "status");

ALTER TABLE "social_connections"
ADD CONSTRAINT "social_connections_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
