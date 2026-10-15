-- TIP-E2E INC-3 A1 (ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED Part F) — screening
-- meetings (additive). Communications still owns the meeting. A screening
-- meeting is associated with the Talent and a new screening_session subject,
-- and its Requisition is OPTIONAL (COMM-V1 R-COMM-REQ-OPTIONAL precedent), so
-- the scheduling ledger's requisition_id becomes nullable for that purpose only.
ALTER TYPE "communications"."CommunicationSubjectType" ADD VALUE IF NOT EXISTS 'screening_session';

ALTER TABLE "communications"."MeetingSchedulingOperation" ALTER COLUMN "requisition_id" DROP NOT NULL;
