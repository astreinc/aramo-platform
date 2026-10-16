-- TIP-E2E INC-3 A1 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Part F) — screening
-- meetings (additive). Communications still owns the meeting. A screening
-- meeting is associated with the Talent and a new screening_session subject,
-- and its Requisition is OPTIONAL (COMM-V1 R-COMM-REQ-OPTIONAL precedent), so
-- the scheduling ledger's requisition_id becomes nullable for that purpose only.
ALTER TYPE "communications"."CommunicationSubjectType" ADD VALUE IF NOT EXISTS 'screening_session';

ALTER TABLE "communications"."MeetingSchedulingOperation" ALTER COLUMN "requisition_id" DROP NOT NULL;

-- The AUTHORITATIVE screening association of a scheduling operation (erasure and
-- audit never infer it from a missing Requisition). A recruiting operation has
-- a Requisition and no session; a screening operation always has its session.
ALTER TABLE "communications"."MeetingSchedulingOperation" ADD COLUMN "screening_session_id" UUID;
ALTER TABLE "communications"."MeetingSchedulingOperation"
  ADD CONSTRAINT "MeetingSchedulingOperation_association_check"
  CHECK ("requisition_id" IS NOT NULL OR "screening_session_id" IS NOT NULL);
CREATE INDEX "MeetingSchedulingOperation_tenant_screening_session_idx"
  ON "communications"."MeetingSchedulingOperation" ("tenant_id", "screening_session_id");
