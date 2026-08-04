CREATE TABLE "product_events" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "route" VARCHAR(240),
    "properties" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_events_eventId_key" ON "product_events"("eventId");
CREATE INDEX "product_events_workspaceId_name_occurredAt_idx" ON "product_events"("workspaceId", "name", "occurredAt");
CREATE INDEX "product_events_userId_occurredAt_idx" ON "product_events"("userId", "occurredAt");

ALTER TABLE "product_events" ADD CONSTRAINT "product_events_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
