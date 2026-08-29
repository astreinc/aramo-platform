-- Lane 2 / L2-F (F2) — the InterviewSession child aggregate of ClientSelectionProcess.
-- A scheduling under a client-selection process: SCHEDULED lifecycle, store-only
-- participants (identity.User UUID refs, no FK), version-CAS. Events reuse the EXISTING
-- client_selection.ClientSelectionEvent table (subject_type='session') and outbox, so
-- this migration adds NO triggers and NO event/outbox change.
--
-- NOTE keep every line comment free of the statement terminator and of the dollar-quote
-- delimiter -- the integration migration splitter is dollar-quote aware but does not
-- strip line comments.

-- CreateEnum
CREATE TYPE "client_selection"."InterviewSessionState" AS ENUM ('SCHEDULED', 'RESCHEDULED', 'COMPLETED', 'CANCELED', 'NO_SHOW');

-- CreateTable
CREATE TABLE "client_selection"."InterviewSession" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "client_selection_process_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "talent_record_id" UUID NOT NULL,
    "site_id" UUID,
    "interview_type" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "scheduled_at" TIMESTAMPTZ NOT NULL,
    "interviewer_user_ids" UUID[],
    "state" "client_selection"."InterviewSessionState" NOT NULL DEFAULT 'SCHEDULED',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "InterviewSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InterviewSession_tenant_id_client_selection_process_id_idx" ON "client_selection"."InterviewSession"("tenant_id", "client_selection_process_id");

-- CreateIndex
CREATE INDEX "InterviewSession_tenant_id_requisition_id_idx" ON "client_selection"."InterviewSession"("tenant_id", "requisition_id");
