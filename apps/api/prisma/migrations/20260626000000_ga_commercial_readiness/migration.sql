-- GA commercial readiness: legal acceptance, email verification, billing idempotency and usage idempotency.

ALTER TABLE "users"
  ADD COLUMN "acceptedTermsVersion" TEXT,
  ADD COLUMN "acceptedPrivacyVersion" TEXT,
  ADD COLUMN "termsAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "privacyAcceptedAt" TIMESTAMP(3);

CREATE TABLE "email_verification_tokens" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "tokenHash" VARCHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_verification_tokens_tokenHash_key" ON "email_verification_tokens"("tokenHash");
CREATE INDEX "email_verification_tokens_userId_expiresAt_idx" ON "email_verification_tokens"("userId", "expiresAt");

ALTER TABLE "email_verification_tokens"
  ADD CONSTRAINT "email_verification_tokens_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "billing_checkouts" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "plan" "Plan" NOT NULL,
  "method" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'mercado_pago',
  "providerResourceId" TEXT,
  "status" TEXT NOT NULL,
  "response" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_checkouts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_checkouts_idempotencyKey_key" ON "billing_checkouts"("idempotencyKey");
CREATE INDEX "billing_checkouts_workspaceId_createdAt_idx" ON "billing_checkouts"("workspaceId", "createdAt");

ALTER TABLE "billing_checkouts"
  ADD CONSTRAINT "billing_checkouts_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "billing_webhook_events" (
  "id" UUID NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'mercado_pago',
  "providerEventId" TEXT NOT NULL,
  "providerResourceId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "processedAt" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload" JSONB,
  "lastError" TEXT,
  CONSTRAINT "billing_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_webhook_events_providerEventId_key" ON "billing_webhook_events"("providerEventId");
CREATE INDEX "billing_webhook_events_status_receivedAt_idx" ON "billing_webhook_events"("status", "receivedAt");

ALTER TABLE "usage_events" ADD COLUMN "idempotencyKey" VARCHAR(160);
CREATE UNIQUE INDEX "usage_events_idempotencyKey_key" ON "usage_events"("idempotencyKey");
