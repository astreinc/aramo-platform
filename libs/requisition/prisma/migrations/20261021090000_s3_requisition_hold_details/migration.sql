-- Talent Lifecycle R1–R5 Implementation Directive v1.2 LOCKED §6 (S3, A1 AM-3) — hold details on
-- the append-only lifecycle event row (ADD-only; the BEFORE UPDATE/DELETE triggers block row
-- mutation, not ADD COLUMN). Every hold keeps its own history; REOPEN needs no clearing write;
-- holds placed before this amendment read as NULL ("not recorded" — never invented, A1 §4).
ALTER TABLE "requisition"."RequisitionLifecycleEvent"
  ADD COLUMN "hold_reason" TEXT,
  ADD COLUMN "hold_source" TEXT,
  ADD COLUMN "hold_effective_at" TIMESTAMPTZ,
  ADD COLUMN "hold_instructions" TEXT;

-- The source vocabulary (client | vms | internal) and a non-empty reason (an empty string can
-- never stand in for a real reason). Valid for every existing row (all NULL).
ALTER TABLE "requisition"."RequisitionLifecycleEvent"
  ADD CONSTRAINT "RequisitionLifecycleEvent_hold_source_chk"
    CHECK ("hold_source" IS NULL OR "hold_source" IN ('client', 'vms', 'internal')),
  ADD CONSTRAINT "RequisitionLifecycleEvent_hold_reason_nonempty_chk"
    CHECK ("hold_reason" IS NULL OR length(btrim("hold_reason")) > 0);

-- Hold details only on an on_hold event. Valid for existing rows (all NULL).
ALTER TABLE "requisition"."RequisitionLifecycleEvent"
  ADD CONSTRAINT "RequisitionLifecycleEvent_hold_only_on_hold_chk"
    CHECK ("next_status"::text = 'on_hold'
           OR ("hold_reason" IS NULL AND "hold_source" IS NULL AND "hold_effective_at" IS NULL AND "hold_instructions" IS NULL));

-- NEW on_hold TRANSITION events (a PUT_ON_HOLD: previous_status present) carry a source, and a
-- reason unless the source is a VMS that supplied none (LR-F C-3). An ESTABLISHMENT event
-- (previous_status NULL — a requisition imported / established already on_hold) has no hold
-- action and therefore no hold details; it reads "not recorded" (typed divergence DV-S3-1).
-- NOT VALID: pre-amendment on_hold rows legitimately have neither ("not recorded").
ALTER TABLE "requisition"."RequisitionLifecycleEvent"
  ADD CONSTRAINT "RequisitionLifecycleEvent_hold_required_chk"
    CHECK ("next_status"::text IS DISTINCT FROM 'on_hold'
           OR "previous_status" IS NULL
           OR ("hold_source" IS NOT NULL AND ("hold_reason" IS NOT NULL OR "hold_source" = 'vms')))
    NOT VALID;
