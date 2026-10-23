-- ATI-SEP-1 Addendum A2 ruling A-c (P1) — the platform-owned MatchingPolicy store.
--
-- Skills taxonomy and matching configuration are platform-owned reference data,
-- governed by the SaaS Platform Owner through the Platform Admin Portal. Tenants
-- consume, cannot edit. Matching execution stays ATS-side (libs/matching reads the
-- ACTIVE version through an injected port; the engine stays pure).
--
-- MatchingPolicyVersion: versioned, append-only policy versions. A version's content
-- (version_number, evidence_thresholds, note, created_by, created_at) is immutable
-- after insert; only the lifecycle columns (status, activated_by, activated_at,
-- retired_at) move. DELETE is rejected. EXACTLY ONE version is ACTIVE (partial
-- unique index). Platform-global: no tenant_id.
--
-- MatchingPolicyAuditEvent: append-only audit stream, one row per change (UPDATE and
-- DELETE rejected, unconditionally, as SkillAuditEvent).
--
-- Seed: version 1 = the compiled section 2.5 Threshold Calibration constants exactly
-- (libs/matching DEFAULT_EVIDENCE_THRESHOLDS), ACTIVE, so behaviour is unchanged.
-- apps/api/src/tests/matching-policy-seed.spec.ts proves the seeded document equals
-- the compiled defaults. Idempotent seed (ON CONFLICT DO NOTHING on fixed ids).
--
-- Carries dollar-quoted trigger bodies, so any integration spec applying this
-- migration MUST use a whole-file DDL applier (pg Client), never a line splitter.

-- CreateTable
CREATE TABLE "skills_taxonomy"."MatchingPolicyVersion" (
    "id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "evidence_thresholds" JSONB NOT NULL,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_by" UUID,
    "activated_at" TIMESTAMPTZ,
    "retired_at" TIMESTAMPTZ,

    CONSTRAINT "MatchingPolicyVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MatchingPolicyVersion_status_check" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'RETIRED')),
    CONSTRAINT "MatchingPolicyVersion_version_number_check" CHECK ("version_number" >= 1),
    CONSTRAINT "MatchingPolicyVersion_evidence_thresholds_check" CHECK (jsonb_typeof("evidence_thresholds") = 'object')
);

-- CreateIndex
CREATE UNIQUE INDEX "MatchingPolicyVersion_version_number_key" ON "skills_taxonomy"."MatchingPolicyVersion"("version_number");
CREATE INDEX "MatchingPolicyVersion_status_idx" ON "skills_taxonomy"."MatchingPolicyVersion"("status");
-- Exactly one ACTIVE version (at most one at the DB; the seed makes it exactly one).
CREATE UNIQUE INDEX "MatchingPolicyVersion_one_active_key" ON "skills_taxonomy"."MatchingPolicyVersion"("status") WHERE "status" = 'ACTIVE';

-- CreateTable
CREATE TABLE "skills_taxonomy"."MatchingPolicyAuditEvent" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchingPolicyAuditEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MatchingPolicyAuditEvent_event_type_check" CHECK ("event_type" IN ('MATCHING_POLICY_VERSION_CREATED', 'MATCHING_POLICY_VERSION_ACTIVATED'))
);

-- CreateIndex
CREATE INDEX "MatchingPolicyAuditEvent_subject_id_created_at_id_idx" ON "skills_taxonomy"."MatchingPolicyAuditEvent"("subject_id", "created_at" DESC, "id" DESC);
CREATE INDEX "MatchingPolicyAuditEvent_created_at_id_idx" ON "skills_taxonomy"."MatchingPolicyAuditEvent"("created_at" DESC, "id" DESC);

-- Append-only version content: reject DELETE, and reject any UPDATE that changes a
-- content column. Lifecycle columns stay writable. IS DISTINCT FROM is NULL-safe.
CREATE OR REPLACE FUNCTION "skills_taxonomy"."guard_matching_policy_version"()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'MatchingPolicyVersion is append-only (DELETE rejected)';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
       OR NEW."evidence_thresholds" IS DISTINCT FROM OLD."evidence_thresholds"
       OR NEW."note" IS DISTINCT FROM OLD."note"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'MatchingPolicyVersion content is immutable (create a new version instead)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "matching_policy_version_guard_update"
    BEFORE UPDATE ON "skills_taxonomy"."MatchingPolicyVersion"
    FOR EACH ROW
    EXECUTE FUNCTION "skills_taxonomy"."guard_matching_policy_version"();

CREATE TRIGGER "matching_policy_version_guard_delete"
    BEFORE DELETE ON "skills_taxonomy"."MatchingPolicyVersion"
    FOR EACH ROW
    EXECUTE FUNCTION "skills_taxonomy"."guard_matching_policy_version"();

CREATE OR REPLACE FUNCTION "skills_taxonomy"."reject_matching_policy_audit_event_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'MatchingPolicyAuditEvent is an append-only governance ledger (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "matching_policy_audit_event_no_update"
    BEFORE UPDATE ON "skills_taxonomy"."MatchingPolicyAuditEvent"
    FOR EACH ROW
    EXECUTE FUNCTION "skills_taxonomy"."reject_matching_policy_audit_event_mutation"();

CREATE TRIGGER "matching_policy_audit_event_no_delete"
    BEFORE DELETE ON "skills_taxonomy"."MatchingPolicyAuditEvent"
    FOR EACH ROW
    EXECUTE FUNCTION "skills_taxonomy"."reject_matching_policy_audit_event_mutation"();

-- Seed version 1 (ACTIVE) = the compiled defaults. Key order follows ROLE_FAMILIES.
-- matching-policy-v1-thresholds
INSERT INTO "skills_taxonomy"."MatchingPolicyVersion"
    ("id", "version_number", "status", "evidence_thresholds", "note", "created_by", "created_at", "activated_by", "activated_at")
VALUES (
    '019a0000-0000-7000-8000-00000000a001',
    1,
    'ACTIVE',
    '{"backend_engineer":{"count":2,"requires_ingested":true},"frontend_engineer":{"count":2,"requires_ingested":true},"fullstack_engineer":{"count":2,"requires_ingested":true},"devops_sre":{"count":2,"requires_ingested":true},"data_engineer":{"count":2,"requires_ingested":true},"architect":{"count":3,"requires_ingested":true},"qa_test_engineer":{"count":2,"requires_ingested":true},"product_project_manager":{"count":2,"requires_ingested":false},"business_analyst":{"count":2,"requires_ingested":false}}'::jsonb,
    'Seed: section 2.5 Threshold Calibration (the compiled engine defaults)',
    NULL,
    CURRENT_TIMESTAMP,
    NULL,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "skills_taxonomy"."MatchingPolicyAuditEvent"
    ("id", "actor_id", "actor_type", "event_type", "subject_id", "event_payload", "created_at")
VALUES (
    '019a0000-0000-7000-8000-00000000a002',
    NULL,
    'system',
    'MATCHING_POLICY_VERSION_ACTIVATED',
    '019a0000-0000-7000-8000-00000000a001',
    '{"version_number":1,"previous_active_version_id":null,"source":"migration_seed"}'::jsonb,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;
