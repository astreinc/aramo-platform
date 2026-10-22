-- ATS-QA-1 I-4 (L2, amendment A3) — recruiter edit of declared education.
-- TalentEducationEntry stays the ONLY education authority and is NOT altered: a
-- correction writes a NEW manual row and RETIRES the superseded one, a removal
-- retires the row. Nothing is overwritten or deleted, so the extracted row and its
-- provenance stay as history. Two additive side tables keyed by the entry id:
--
--   EducationEntryRetirement — at most one retirement per entry (the primary key
--     makes a concurrent second correction or removal of the same entry fail
--     deterministically). reason corrected carries the replacing entry id.
--   EducationEntryAuditEvent — append-only, one event per change (added /
--     corrected / removed) with the acting user and the changed field NAMES only
--     (never the values).
--
-- Neither table carries a Talent column or any personal value: the Talent is
-- reached through the entry id. Additive only (ADD-not-rename).

-- CreateTable
CREATE TABLE "talent_evidence"."EducationEntryRetirement" (
    "entry_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "superseded_by_entry_id" UUID,
    "retired_by_id" UUID NOT NULL,
    "retired_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "EducationEntryRetirement_pkey" PRIMARY KEY ("entry_id"),
    CONSTRAINT "EducationEntryRetirement_reason_check" CHECK ("reason" IN ('corrected', 'removed')),
    CONSTRAINT "EducationEntryRetirement_superseded_by_check" CHECK (("reason" = 'corrected') = ("superseded_by_entry_id" IS NOT NULL))
);

-- CreateTable
CREATE TABLE "talent_evidence"."EducationEntryAuditEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "related_entry_id" UUID,
    "changed_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "occurred_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "EducationEntryAuditEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EducationEntryAuditEvent_action_check" CHECK ("action" IN ('added', 'corrected', 'removed'))
);

-- CreateIndex
CREATE INDEX "EducationEntryRetirement_tenant_id_idx" ON "talent_evidence"."EducationEntryRetirement"("tenant_id");

-- CreateIndex
CREATE INDEX "EducationEntryRetirement_superseded_by_entry_id_idx" ON "talent_evidence"."EducationEntryRetirement"("superseded_by_entry_id");

-- CreateIndex
CREATE INDEX "EducationEntryAuditEvent_tenant_id_entry_id_idx" ON "talent_evidence"."EducationEntryAuditEvent"("tenant_id", "entry_id");
