-- ATI-SEP-1 T10 WP2 (Addenda A2 F-1 / A3) — ATS-local identity. Additive only.
--
--   1. talent_duplicate_advisory — within-tenant duplicate advisories detected
--      from ATS data (shared normalized email1 / cell phone between two live
--      records, or a sourced arrival sharing one with a live record). Replaces
--      the retired trust-ledger match advisory for every ATS surface. Canonical
--      pair order (a < b); exactly one of talent_record_b_id / sourced_talent_id.
--      merge_state holds the durable re-home checkpoint (resumable + reversible).
--   2. talent_record_sourced_arrival — the sourced arrival -> TalentRecord link
--      (PROMOTED in the promotion create transaction, or ADVISORY_APPROVED).
--
-- TalentRecord.cluster_id becomes INERT (no writer remains; ADD-not-rename).
-- No existing returned API shape changes: neither table is projected onto a
-- TalentRecord view.

-- 1.
CREATE TABLE "talent_record"."talent_duplicate_advisory" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "talent_record_a_id" UUID NOT NULL,
  "talent_record_b_id" UUID,
  "sourced_talent_id" UUID,
  "basis" TEXT NOT NULL,
  "shared_kinds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  "decided_by" TEXT,
  "decided_at" TIMESTAMPTZ,
  "justification" TEXT,
  "surviving_record_id" UUID,
  "superseded_record_id" UUID,
  "merge_state" JSONB,
  "merge_completed_at" TIMESTAMPTZ,
  "reversed_by" TEXT,
  "reversed_at" TIMESTAMPTZ,
  "reversal_justification" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "talent_duplicate_advisory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "talent_duplicate_advisory_basis_check"
    CHECK ("basis" IN ('EMAIL', 'PHONE', 'SOURCED_ARRIVAL')),
  CONSTRAINT "talent_duplicate_advisory_status_check"
    CHECK ("status" IN ('PENDING_REVIEW', 'APPROVED', 'DISMISSED', 'REVERSED')),
  CONSTRAINT "talent_duplicate_advisory_pair_check" CHECK (
    ("talent_record_b_id" IS NOT NULL AND "sourced_talent_id" IS NULL
       AND "talent_record_a_id" < "talent_record_b_id" AND "basis" <> 'SOURCED_ARRIVAL')
    OR ("talent_record_b_id" IS NULL AND "sourced_talent_id" IS NOT NULL
       AND "basis" = 'SOURCED_ARRIVAL')
  ),
  CONSTRAINT "talent_duplicate_advisory_talent_record_a_id_fkey" FOREIGN KEY ("talent_record_a_id")
    REFERENCES "talent_record"."TalentRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "talent_duplicate_advisory_talent_record_b_id_fkey" FOREIGN KEY ("talent_record_b_id")
    REFERENCES "talent_record"."TalentRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "talent_duplicate_advisory_pair_key"
  ON "talent_record"."talent_duplicate_advisory" ("tenant_id", "talent_record_a_id", "talent_record_b_id");
CREATE UNIQUE INDEX "talent_duplicate_advisory_arrival_key"
  ON "talent_record"."talent_duplicate_advisory" ("tenant_id", "talent_record_a_id", "sourced_talent_id");
CREATE INDEX "talent_duplicate_advisory_queue_idx"
  ON "talent_record"."talent_duplicate_advisory" ("tenant_id", "status", "created_at");
CREATE INDEX "talent_duplicate_advisory_sourced_idx"
  ON "talent_record"."talent_duplicate_advisory" ("tenant_id", "sourced_talent_id");
CREATE INDEX "talent_duplicate_advisory_b_idx"
  ON "talent_record"."talent_duplicate_advisory" ("talent_record_b_id");

-- 2.
CREATE TABLE "talent_record"."talent_record_sourced_arrival" (
  "tenant_id" UUID NOT NULL,
  "sourced_talent_id" UUID NOT NULL,
  "talent_record_id" UUID NOT NULL,
  "link_kind" TEXT NOT NULL,
  "advisory_id" UUID,
  "linked_by" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "talent_record_sourced_arrival_pkey" PRIMARY KEY ("tenant_id", "sourced_talent_id"),
  CONSTRAINT "talent_record_sourced_arrival_link_kind_check"
    CHECK ("link_kind" IN ('PROMOTED', 'ADVISORY_APPROVED')),
  CONSTRAINT "talent_record_sourced_arrival_talent_record_id_fkey" FOREIGN KEY ("talent_record_id")
    REFERENCES "talent_record"."TalentRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "talent_record_sourced_arrival_record_idx"
  ON "talent_record"."talent_record_sourced_arrival" ("tenant_id", "talent_record_id");
