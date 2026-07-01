ALTER TABLE "upload_attempts"
  ADD COLUMN "providerUploadId" TEXT,
  ADD COLUMN "expectedSizeBytes" BIGINT,
  ADD COLUMN "expectedMimeType" TEXT,
  ADD COLUMN "expiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "upload_attempts_providerUploadId_key"
  ON "upload_attempts"("providerUploadId");
