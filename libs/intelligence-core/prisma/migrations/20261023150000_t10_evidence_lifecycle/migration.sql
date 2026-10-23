-- ATI-SEP-1 T10 (Addendum A3 T10-2) — the Talent Intelligence evidence lifecycle:
-- talent-raised disputes of an Assertion (thread + append-only audit), the
-- per-tenant trust-proposal worklist, and the RECONCILES assertion link written
-- by contradiction resolution. Applied ONLY by tools/db-sync-intelligence.sh.
-- splitDdl-safe: no semicolons in comments.

-- CreateTable
CREATE TABLE "intelligence"."AssertionDispute" (
    "id" UUID NOT NULL,
    "assertion_id" UUID NOT NULL,
    "opened_via_reference_id" UUID NOT NULL,
    "opened_by" TEXT NOT NULL DEFAULT 'TALENT',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution_note" TEXT,
    "no_transition_reason" TEXT,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triage_due_at" TIMESTAMPTZ(6) NOT NULL,
    "summary_due_at" TIMESTAMPTZ(6) NOT NULL,
    "reinvestigation_due_at" TIMESTAMPTZ(6) NOT NULL,
    "reinvestigation_extended_at" TIMESTAMPTZ(6),
    "ccpa_due_at" TIMESTAMPTZ(6),
    "ccpa_extended_due_at" TIMESTAMPTZ(6),
    "triaged_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "withdrawn_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssertionDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."AssertionDisputeStatement" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "author" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "statement_hash" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssertionDisputeStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."AssertionDisputeEvent" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "actor" TEXT NOT NULL,
    "source_system_id" TEXT,
    "source_tenant_id" TEXT,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssertionDisputeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."VerificationProposal" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "source_system_id" TEXT NOT NULL,
    "source_tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "trigger_kind" TEXT NOT NULL,
    "basis_ref" TEXT NOT NULL,
    "assertion_id" UUID,
    "identifier_type" TEXT,
    "identifier_digest" TEXT,
    "basis_snapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "justification" TEXT,
    "action" TEXT,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "resolved_by" TEXT,
    "acted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VerificationProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssertionDispute_assertion_id_idx" ON "intelligence"."AssertionDispute"("assertion_id");

-- CreateIndex
CREATE INDEX "AssertionDispute_status_opened_at_idx" ON "intelligence"."AssertionDispute"("status", "opened_at");

-- CreateIndex
CREATE INDEX "AssertionDisputeStatement_dispute_id_created_at_idx" ON "intelligence"."AssertionDisputeStatement"("dispute_id", "created_at");

-- CreateIndex
CREATE INDEX "AssertionDisputeEvent_dispute_id_created_at_idx" ON "intelligence"."AssertionDisputeEvent"("dispute_id", "created_at");

-- CreateIndex
CREATE INDEX "VerificationProposal_source_system_id_source_tenant_id_stat_idx" ON "intelligence"."VerificationProposal"("source_system_id", "source_tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "VerificationProposal_subject_id_idx" ON "intelligence"."VerificationProposal"("subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationProposal_source_system_id_source_tenant_id_subj_key" ON "intelligence"."VerificationProposal"("source_system_id", "source_tenant_id", "subject_id", "kind", "basis_ref");

-- AddForeignKey
ALTER TABLE "intelligence"."AssertionDispute" ADD CONSTRAINT "AssertionDispute_assertion_id_fkey" FOREIGN KEY ("assertion_id") REFERENCES "intelligence"."Assertion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."AssertionDispute" ADD CONSTRAINT "AssertionDispute_opened_via_reference_id_fkey" FOREIGN KEY ("opened_via_reference_id") REFERENCES "intelligence"."ExternalTalentReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."AssertionDisputeStatement" ADD CONSTRAINT "AssertionDisputeStatement_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "intelligence"."AssertionDispute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."AssertionDisputeEvent" ADD CONSTRAINT "AssertionDisputeEvent_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "intelligence"."AssertionDispute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."VerificationProposal" ADD CONSTRAINT "VerificationProposal_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "intelligence"."GoldenTalent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."VerificationProposal" ADD CONSTRAINT "VerificationProposal_assertion_id_fkey" FOREIGN KEY ("assertion_id") REFERENCES "intelligence"."Assertion"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ============================================================================
-- Closed vocabularies as CHECK constraints.
-- ============================================================================
ALTER TABLE "intelligence"."AssertionLink" DROP CONSTRAINT "AssertionLink_link_type_check";
ALTER TABLE "intelligence"."AssertionLink"
  ADD CONSTRAINT "AssertionLink_link_type_check" CHECK ("link_type" IN ('CORROBORATES', 'CONTRADICTS', 'SUPERSEDES', 'RECONCILES'));

ALTER TABLE "intelligence"."AssertionDispute"
  ADD CONSTRAINT "AssertionDispute_opened_by_check" CHECK ("opened_by" IN ('TALENT')),
  ADD CONSTRAINT "AssertionDispute_status_check" CHECK ("status" IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED_CORRECTED', 'RESOLVED_UPHELD', 'WITHDRAWN', 'RESOLVED_NO_TRANSITION')),
  ADD CONSTRAINT "AssertionDispute_withdrawn_check" CHECK (("status" = 'WITHDRAWN') = ("withdrawn_at" IS NOT NULL)),
  ADD CONSTRAINT "AssertionDispute_no_transition_check" CHECK (("status" = 'RESOLVED_NO_TRANSITION') = ("no_transition_reason" IS NOT NULL));

ALTER TABLE "intelligence"."AssertionDisputeStatement"
  ADD CONSTRAINT "AssertionDisputeStatement_author_check" CHECK ("author" IN ('TALENT', 'TENANT')),
  ADD CONSTRAINT "AssertionDisputeStatement_channel_check" CHECK ("channel" IN ('portal', 'tenant')),
  ADD CONSTRAINT "AssertionDisputeStatement_hash_check" CHECK ("statement_hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "AssertionDisputeStatement_length_check" CHECK (char_length("statement") BETWEEN 1 AND 4000);

ALTER TABLE "intelligence"."AssertionDisputeEvent"
  ADD CONSTRAINT "AssertionDisputeEvent_event_type_check" CHECK ("event_type" IN ('OPENED', 'STATEMENT_ADDED', 'TRIAGED', 'INFO_REQUESTED', 'CORRECTED', 'UPHELD', 'WITHDRAWN', 'EXTENDED', 'NO_TRANSITION'));

ALTER TABLE "intelligence"."VerificationProposal"
  ADD CONSTRAINT "VerificationProposal_kind_check" CHECK ("kind" IN ('VERIFY_CONTACT', 'RENEW_VERIFICATION', 'RESOLVE_CONTRADICTION')),
  ADD CONSTRAINT "VerificationProposal_trigger_kind_check" CHECK ("trigger_kind" IN ('SINGLE_SOURCE_ONLY', 'VERIFICATION_STALE', 'OPEN_CONTRADICTION')),
  ADD CONSTRAINT "VerificationProposal_status_check" CHECK ("status" IN ('OPEN', 'DISMISSED', 'ACTED', 'SETTLED')),
  ADD CONSTRAINT "VerificationProposal_action_check" CHECK ("action" IS NULL OR "action" IN ('VERIFICATION_REQUESTED', 'CONTRADICTION_RESOLVED', 'RECORD_UPDATED')),
  ADD CONSTRAINT "VerificationProposal_identifier_type_check" CHECK ("identifier_type" IS NULL OR "identifier_type" IN ('EMAIL', 'PHONE')),
  ADD CONSTRAINT "VerificationProposal_identifier_digest_check" CHECK ("identifier_digest" IS NULL OR "identifier_digest" ~ '^[a-f0-9]{64}$'),
  -- A dismissal always carries its justification, an act its action.
  ADD CONSTRAINT "VerificationProposal_dismissed_check" CHECK ("status" <> 'DISMISSED' OR "justification" IS NOT NULL),
  ADD CONSTRAINT "VerificationProposal_acted_check" CHECK (("status" = 'ACTED') = ("action" IS NOT NULL)),
  ADD CONSTRAINT "VerificationProposal_resolved_check" CHECK (("status" = 'OPEN') = ("acted_at" IS NULL));

-- One OPEN / UNDER_REVIEW dispute per assertion (the open-idempotency backstop).
CREATE UNIQUE INDEX "AssertionDispute_one_open_per_assertion"
  ON "intelligence"."AssertionDispute" ("assertion_id")
  WHERE "status" IN ('OPEN', 'UNDER_REVIEW');

-- The thread is append-only. The audit is append-only and retained.
CREATE TRIGGER assertion_dispute_statement_no_update
  BEFORE UPDATE ON "intelligence"."AssertionDisputeStatement"
  FOR EACH ROW EXECUTE FUNCTION "intelligence".reject_update_append_only();

CREATE TRIGGER assertion_dispute_event_no_update
  BEFORE UPDATE ON "intelligence"."AssertionDisputeEvent"
  FOR EACH ROW EXECUTE FUNCTION "intelligence".reject_update_append_only();

CREATE TRIGGER assertion_dispute_event_no_delete
  BEFORE DELETE ON "intelligence"."AssertionDisputeEvent"
  FOR EACH ROW EXECUTE FUNCTION "intelligence".reject_evidence_delete();

INSERT INTO "intelligence"."ServiceInfo" ("key", "value")
VALUES ('evidence_lifecycle', 'ATI-SEP-1-T10')
ON CONFLICT ("key") DO NOTHING;
