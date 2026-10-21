-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DELETING');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "FieldState" AS ENUM ('PRESENT', 'ABSENT', 'UNKNOWN', 'ERROR');

-- CreateTable
CREATE TABLE "Document" (
    "id" UUID NOT NULL,
    "ownerId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "checksum" CHAR(64) NOT NULL,
    "objectKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingJob" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "pipelineVersion" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "transitions" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageArtifact" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "parser" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "routingReason" TEXT NOT NULL,
    "inspection" JSONB NOT NULL,
    "text" TEXT NOT NULL,
    "blocks" JSONB NOT NULL,
    "warnings" JSONB NOT NULL,
    "durationMs" INTEGER NOT NULL,

    CONSTRAINT "PageArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedField" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "instance" INTEGER NOT NULL DEFAULT 0,
    "state" "FieldState" NOT NULL,
    "value" TEXT,
    "evidence" JSONB NOT NULL,
    "supported" BOOLEAN,
    "errorCode" TEXT,

    CONSTRAINT "ExtractedField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelInvocation" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "invocationKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estimatedCost" DECIMAL(14,8),
    "pricingVersion" TEXT,
    "durationMs" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "errorCode" TEXT,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Document_objectKey_key" ON "Document"("objectKey");

-- CreateIndex
CREATE INDEX "Document_ownerId_createdAt_idx" ON "Document"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "Document_expiresAt_status_idx" ON "Document"("expiresAt", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Document_ownerId_idempotencyKey_key" ON "Document"("ownerId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ProcessingJob_status_updatedAt_idx" ON "ProcessingJob"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingJob_documentId_version_key" ON "ProcessingJob"("documentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PageArtifact_jobId_pageNumber_key" ON "PageArtifact"("jobId", "pageNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractedField_jobId_category_instance_key" ON "ExtractedField"("jobId", "category", "instance");

-- CreateIndex
CREATE UNIQUE INDEX "ModelInvocation_jobId_invocationKey_key" ON "ModelInvocation"("jobId", "invocationKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_availableAt_idx" ON "OutboxEvent"("publishedAt", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_jobId_type_key" ON "OutboxEvent"("jobId", "type");

-- AddForeignKey
ALTER TABLE "ProcessingJob" ADD CONSTRAINT "ProcessingJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageArtifact" ADD CONSTRAINT "PageArtifact_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProcessingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedField" ADD CONSTRAINT "ExtractedField_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProcessingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelInvocation" ADD CONSTRAINT "ModelInvocation_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProcessingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ProcessingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

