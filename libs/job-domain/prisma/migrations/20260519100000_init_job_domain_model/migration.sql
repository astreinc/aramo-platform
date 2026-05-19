-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "job_domain";

-- CreateEnum
CREATE TYPE "job_domain"."RequisitionState" AS ENUM ('active', 'inactive');

-- CreateTable
CREATE TABLE "job_domain"."Job" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_domain"."GoldenProfile" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "skills" JSONB NOT NULL,
    "experience" JSONB NOT NULL,
    "constraints" JSONB NOT NULL,
    "critical_skills" TEXT[],

    CONSTRAINT "GoldenProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_domain"."Requisition" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "recruiter_id" UUID NOT NULL,
    "state" "job_domain"."RequisitionState" NOT NULL,

    CONSTRAINT "Requisition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_tenant_id_idx" ON "job_domain"."Job"("tenant_id");

-- CreateIndex
CREATE INDEX "GoldenProfile_tenant_id_idx" ON "job_domain"."GoldenProfile"("tenant_id");

-- CreateIndex
CREATE INDEX "GoldenProfile_tenant_id_job_id_idx" ON "job_domain"."GoldenProfile"("tenant_id", "job_id");

-- CreateIndex
CREATE INDEX "Requisition_tenant_id_idx" ON "job_domain"."Requisition"("tenant_id");

-- CreateIndex
CREATE INDEX "Requisition_tenant_id_recruiter_id_idx" ON "job_domain"."Requisition"("tenant_id", "recruiter_id");

-- CreateIndex
CREATE INDEX "Requisition_tenant_id_job_id_idx" ON "job_domain"."Requisition"("tenant_id", "job_id");

