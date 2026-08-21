-- L8-B1 SubmittalEligibility init migration (schema submittal_policy).
-- Governed by Aramo-Requisition-Submittal-Eligibility-Implementation-Directive-v1_0-LOCKED.
-- Cross-schema references are UUID-only, no FK (Architecture §7.3).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "submittal_policy";

-- CreateEnum
CREATE TYPE "submittal_policy"."SubmittalAuthority" AS ENUM ('CLIENT_VMS', 'CLIENT_MANUAL', 'ARAMO');

-- CreateEnum
CREATE TYPE "submittal_policy"."SubmittalWindowStatus" AS ENUM ('OPEN', 'CLOSED', 'PAUSED');

-- CreateEnum
CREATE TYPE "submittal_policy"."SubmittalPolicyReason" AS ENUM ('SHORTLISTING_STARTED', 'CLIENT_DEADLINE', 'QUOTA_EXHAUSTED', 'MANUAL', 'VMS_SUSPENDED', 'OTHER');

-- CreateTable
CREATE TABLE "submittal_policy"."RequisitionSubmittalPolicy" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "submittal_deadline" TIMESTAMPTZ(6),
    "shortlisting_deadline" TIMESTAMPTZ(6),
    "submittal_limit" INTEGER,
    "submittal_authority" "submittal_policy"."SubmittalAuthority" NOT NULL DEFAULT 'ARAMO',
    "manual_override" "submittal_policy"."SubmittalWindowStatus",
    "submittal_reason" "submittal_policy"."SubmittalPolicyReason",
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RequisitionSubmittalPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submittal_policy"."SubmittalConsumption" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "talent_record_id" UUID NOT NULL,
    "submittal_id" UUID NOT NULL,
    "consumed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmittalConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submittal_policy"."SubmittalPolicyEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "previous_status" "submittal_policy"."SubmittalWindowStatus",
    "next_status" "submittal_policy"."SubmittalWindowStatus",
    "authority" "submittal_policy"."SubmittalAuthority" NOT NULL,
    "reason" "submittal_policy"."SubmittalPolicyReason",
    "actor_id" UUID,
    "origin" TEXT NOT NULL,
    "effective_at" TIMESTAMPTZ(6) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmittalPolicyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RequisitionSubmittalPolicy_tenant_id_requisition_id_key" ON "submittal_policy"."RequisitionSubmittalPolicy"("tenant_id", "requisition_id");

-- CreateIndex
CREATE UNIQUE INDEX "SubmittalConsumption_tenant_id_requisition_id_talent_record_key" ON "submittal_policy"."SubmittalConsumption"("tenant_id", "requisition_id", "talent_record_id");

-- CreateIndex
CREATE INDEX "SubmittalConsumption_tenant_id_requisition_id_idx" ON "submittal_policy"."SubmittalConsumption"("tenant_id", "requisition_id");

-- CreateIndex
CREATE INDEX "SubmittalPolicyEvent_tenant_id_requisition_id_occurred_at_idx" ON "submittal_policy"."SubmittalPolicyEvent"("tenant_id", "requisition_id", "occurred_at");
