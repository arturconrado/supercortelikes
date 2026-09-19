CREATE TYPE "OpportunityStatus" AS ENUM ('OBSERVING', 'TESTING', 'ACTIVE', 'SCALING', 'DECLINING', 'MIGRATING', 'DEAD');
CREATE TYPE "GateDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "DigitalProductStatus" AS ENUM ('DRAFT', 'QA_REQUIRED', 'READY', 'ARCHIVED');
CREATE TYPE "OfferType" AS ENUM ('PRODUCT', 'SERVICE', 'HYBRID');
CREATE TYPE "BrowserAutomationKind" AS ENUM ('MARKET_RESEARCH', 'PRODUCT_SUBMISSION', 'CONTENT_SCHEDULING', 'COMPETITOR_REVIEW', 'CUSTOM');
CREATE TYPE "BrowserAutomationStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'REVIEW_REQUIRED', 'CANCELLED');
CREATE TYPE "MediaAssetKind" AS ENUM ('LANDING_PAGE', 'STATIC_IMAGE', 'CAROUSEL', 'SHORT_VIDEO', 'AUDIO_SCRIPT', 'WHATSAPP_COPY', 'EMAIL', 'DIAGNOSTIC_FORM', 'PROPOSAL_PDF', 'SERVICE_ONEPAGER', 'CHECKOUT_COPY');
CREATE TYPE "MediaAssetStatus" AS ENUM ('DRAFT', 'READY', 'REVIEW_REQUIRED', 'APPROVED', 'ARCHIVED');
CREATE TYPE "OfferLaunchStatus" AS ENUM ('DRAFT', 'READY', 'RUNNING', 'REVIEW_REQUIRED', 'COMPLETED', 'FAILED');
CREATE TYPE "OfferPublicationStatus" AS ENUM ('DRAFT', 'READY', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED');
CREATE TYPE "OfferProductionStageName" AS ENUM ('OFFER', 'MEDIA_ASSETS', 'PUBLICATION_DRAFTS', 'METRICS_SETUP');

CREATE TABLE "market_opportunities" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "createdById" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "audience" TEXT NOT NULL,
  "pain" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "offerType" "OfferType" NOT NULL DEFAULT 'PRODUCT',
  "status" "OpportunityStatus" NOT NULL DEFAULT 'OBSERVING',
  "gateDecision" "GateDecision" NOT NULL DEFAULT 'PENDING',
  "score" INTEGER NOT NULL,
  "demandScore" INTEGER NOT NULL,
  "saturationScore" INTEGER NOT NULL,
  "monetizationScore" INTEGER NOT NULL,
  "channelFitScore" INTEGER NOT NULL,
  "evidenceSummary" TEXT NOT NULL,
  "agentRationale" TEXT NOT NULL,
  "nextAction" TEXT NOT NULL,
  "sourceTags" JSONB NOT NULL,
  "recommendedMedia" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  CONSTRAINT "market_opportunities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "opportunity_signals" (
  "id" UUID NOT NULL,
  "opportunityId" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "strength" INTEGER NOT NULL,
  "url" TEXT,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  CONSTRAINT "opportunity_signals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "browser_automation_runs" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "createdById" UUID NOT NULL,
  "opportunityId" UUID,
  "kind" "BrowserAutomationKind" NOT NULL,
  "status" "BrowserAutomationStatus" NOT NULL DEFAULT 'QUEUED',
  "provider" TEXT NOT NULL,
  "targetUrl" TEXT NOT NULL,
  "goal" TEXT NOT NULL,
  "allowedActions" JSONB NOT NULL,
  "blockedActions" JSONB NOT NULL,
  "steps" JSONB NOT NULL,
  "result" JSONB,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "browser_automation_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "digital_products" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "opportunityId" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "offerType" "OfferType" NOT NULL DEFAULT 'PRODUCT',
  "status" "DigitalProductStatus" NOT NULL DEFAULT 'DRAFT',
  "priceCents" INTEGER NOT NULL DEFAULT 1900,
  "qualityScore" INTEGER NOT NULL DEFAULT 0,
  "outline" JSONB NOT NULL,
  "serviceBlueprint" JSONB,
  "mediaPlan" JSONB NOT NULL,
  "assets" JSONB NOT NULL,
  "qaFindings" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "digital_products_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "offer_media_assets" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "kind" "MediaAssetKind" NOT NULL,
  "status" "MediaAssetStatus" NOT NULL DEFAULT 'DRAFT',
  "title" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "objective" TEXT NOT NULL,
  "brief" TEXT NOT NULL,
  "body" JSONB NOT NULL,
  "qaChecklist" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "offer_media_assets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "offer_launch_runs" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "opportunityId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "status" "OfferLaunchStatus" NOT NULL DEFAULT 'DRAFT',
  "mode" TEXT NOT NULL DEFAULT 'manual',
  "steps" JSONB NOT NULL,
  "result" JSONB,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "offer_launch_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "offer_production_stage_executions" (
  "id" UUID NOT NULL,
  "launchRunId" UUID NOT NULL,
  "stage" "OfferProductionStageName" NOT NULL,
  "status" "StageExecutionStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "output" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "offer_production_stage_executions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "offer_production_outbox_events" (
  "id" UUID NOT NULL,
  "launchRunId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "publishedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "offer_production_outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "offer_publication_drafts" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "status" "OfferPublicationStatus" NOT NULL DEFAULT 'DRAFT',
  "title" TEXT NOT NULL,
  "body" JSONB NOT NULL,
  "scheduledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "offer_publication_drafts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "offer_metric_snapshots" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "opportunityId" UUID NOT NULL,
  "productId" UUID,
  "source" TEXT NOT NULL,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "leads" INTEGER NOT NULL DEFAULT 0,
  "sales" INTEGER NOT NULL DEFAULT 0,
  "revenueCents" INTEGER NOT NULL DEFAULT 0,
  "costCents" INTEGER NOT NULL DEFAULT 0,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metadata" JSONB,
  CONSTRAINT "offer_metric_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "market_opportunities_workspaceId_status_score_idx" ON "market_opportunities"("workspaceId", "status", "score");
CREATE INDEX "market_opportunities_workspaceId_gateDecision_updatedAt_idx" ON "market_opportunities"("workspaceId", "gateDecision", "updatedAt");
CREATE INDEX "opportunity_signals_opportunityId_strength_idx" ON "opportunity_signals"("opportunityId", "strength");
CREATE INDEX "browser_automation_runs_workspaceId_status_createdAt_idx" ON "browser_automation_runs"("workspaceId", "status", "createdAt");
CREATE INDEX "browser_automation_runs_opportunityId_createdAt_idx" ON "browser_automation_runs"("opportunityId", "createdAt");
CREATE INDEX "digital_products_workspaceId_status_updatedAt_idx" ON "digital_products"("workspaceId", "status", "updatedAt");
CREATE INDEX "digital_products_opportunityId_createdAt_idx" ON "digital_products"("opportunityId", "createdAt");
CREATE INDEX "offer_media_assets_workspaceId_kind_status_idx" ON "offer_media_assets"("workspaceId", "kind", "status");
CREATE INDEX "offer_media_assets_productId_kind_idx" ON "offer_media_assets"("productId", "kind");
CREATE INDEX "offer_launch_runs_workspaceId_status_createdAt_idx" ON "offer_launch_runs"("workspaceId", "status", "createdAt");
CREATE INDEX "offer_launch_runs_opportunityId_createdAt_idx" ON "offer_launch_runs"("opportunityId", "createdAt");
CREATE UNIQUE INDEX "offer_production_stage_executions_launchRunId_stage_key" ON "offer_production_stage_executions"("launchRunId", "stage");
CREATE INDEX "offer_production_stage_executions_status_updatedAt_idx" ON "offer_production_stage_executions"("status", "updatedAt");
CREATE INDEX "offer_production_outbox_events_publishedAt_availableAt_createdAt_idx" ON "offer_production_outbox_events"("publishedAt", "availableAt", "createdAt");
CREATE INDEX "offer_production_outbox_events_launchRunId_createdAt_idx" ON "offer_production_outbox_events"("launchRunId", "createdAt");
CREATE INDEX "offer_publication_drafts_workspaceId_status_createdAt_idx" ON "offer_publication_drafts"("workspaceId", "status", "createdAt");
CREATE INDEX "offer_publication_drafts_productId_channel_idx" ON "offer_publication_drafts"("productId", "channel");
CREATE INDEX "offer_metric_snapshots_workspaceId_capturedAt_idx" ON "offer_metric_snapshots"("workspaceId", "capturedAt");
CREATE INDEX "offer_metric_snapshots_opportunityId_capturedAt_idx" ON "offer_metric_snapshots"("opportunityId", "capturedAt");

ALTER TABLE "market_opportunities" ADD CONSTRAINT "market_opportunities_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "market_opportunities" ADD CONSTRAINT "market_opportunities_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "opportunity_signals" ADD CONSTRAINT "opportunity_signals_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "market_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "browser_automation_runs" ADD CONSTRAINT "browser_automation_runs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "browser_automation_runs" ADD CONSTRAINT "browser_automation_runs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "browser_automation_runs" ADD CONSTRAINT "browser_automation_runs_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "market_opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "digital_products" ADD CONSTRAINT "digital_products_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "digital_products" ADD CONSTRAINT "digital_products_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "market_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offer_media_assets" ADD CONSTRAINT "offer_media_assets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offer_media_assets" ADD CONSTRAINT "offer_media_assets_productId_fkey" FOREIGN KEY ("productId") REFERENCES "digital_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offer_launch_runs" ADD CONSTRAINT "offer_launch_runs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offer_launch_runs" ADD CONSTRAINT "offer_launch_runs_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "market_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offer_launch_runs" ADD CONSTRAINT "offer_launch_runs_productId_fkey" FOREIGN KEY ("productId") REFERENCES "digital_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offer_production_stage_executions" ADD CONSTRAINT "offer_production_stage_executions_launchRunId_fkey" FOREIGN KEY ("launchRunId") REFERENCES "offer_launch_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offer_production_outbox_events" ADD CONSTRAINT "offer_production_outbox_events_launchRunId_fkey" FOREIGN KEY ("launchRunId") REFERENCES "offer_launch_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offer_publication_drafts" ADD CONSTRAINT "offer_publication_drafts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offer_publication_drafts" ADD CONSTRAINT "offer_publication_drafts_productId_fkey" FOREIGN KEY ("productId") REFERENCES "digital_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offer_metric_snapshots" ADD CONSTRAINT "offer_metric_snapshots_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offer_metric_snapshots" ADD CONSTRAINT "offer_metric_snapshots_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "market_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "offer_metric_snapshots" ADD CONSTRAINT "offer_metric_snapshots_productId_fkey" FOREIGN KEY ("productId") REFERENCES "digital_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
