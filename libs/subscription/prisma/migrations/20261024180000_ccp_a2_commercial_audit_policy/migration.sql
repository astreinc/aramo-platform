-- CCP-A2 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A2; Charter §7 / D5 / D10)
-- — the commercial audit stream and the versioned commercial policy.
--
-- ADDITIVE ONLY: three new tables, their indexes, guard functions and triggers, and the
-- v1 seed. No existing table, column, index or row changes. The pattern is CLONED from
-- skills_taxonomy."MatchingPolicyVersion" (20261023140000_matching_policy), never imported
-- (that lib is scope:cip; this one is scope:shared). The ADR-0024 policy store is not used
-- (D10).
--
-- CommercialPolicyVersion: DRAFT | ACTIVE | RETIRED. Content (content, content_checksum,
-- note) is editable only while the row is DRAFT and immutable once it leaves DRAFT;
-- identity columns are immutable always; DELETE is rejected always. Allowed status moves:
-- DRAFT → ACTIVE, ACTIVE → RETIRED, RETIRED → ACTIVE (the rollback path; A3 makes every
-- activation a change request). At most one ACTIVE (partial unique index); the seed makes
-- it exactly one. content_checksum = SHA-256 of the canonical JSON of content
-- (libs/subscription commercialPolicyChecksum); the fail-closed parser recomputes it on
-- every read.
--
-- CommercialPolicyAuditEvent: append-only policy-lifecycle stream (UPDATE and DELETE
-- rejected unconditionally, as MatchingPolicyAuditEvent).
--
-- CommercialAuditEvent: the append-only commercial audit stream for every CCP action
-- (UPDATE and DELETE rejected unconditionally). change_request_id has no FK yet (A3 adds
-- CommercialChangeRequest and the FK). Read by GET /platform/commercial/audit-events
-- (platform:commercial:audit:read).
--
-- Seed: v1 ACTIVE with the Charter §7 (D5) values as policy DATA, its policy audit row,
-- and its commercial audit row. Fixed ids + ON CONFLICT DO NOTHING (idempotent).
--
-- Carries dollar-quoted trigger bodies: any spec applying this migration MUST use a
-- whole-file DDL applier (pg Client), never a line splitter.
--
-- Compensating migration (documented, not shipped; doc/ccp/slices/CCP-A2-acceptance.md):
-- DROP the three tables (CommercialAuditEvent first: it references the policy table) and
-- the three guard functions. Destructive: it discards the audit stream, so it needs its own
-- authorization, and it is refused once A3+ rows reference a policy version.

-- ---------------------------------------------------------------------------------------
-- CommercialPolicyVersion
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."CommercialPolicyVersion" (
    "id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "content" JSONB NOT NULL,
    "content_checksum" TEXT NOT NULL,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_by" UUID,
    "activated_at" TIMESTAMPTZ,
    "retired_at" TIMESTAMPTZ,

    CONSTRAINT "CommercialPolicyVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommercialPolicyVersion_status_check" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'RETIRED')),
    CONSTRAINT "CommercialPolicyVersion_version_number_check" CHECK ("version_number" >= 1),
    CONSTRAINT "CommercialPolicyVersion_content_check" CHECK (jsonb_typeof("content") = 'object'),
    CONSTRAINT "CommercialPolicyVersion_content_checksum_check" CHECK ("content_checksum" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "CommercialPolicyVersion_active_activated_check" CHECK ("status" <> 'ACTIVE' OR "activated_at" IS NOT NULL)
);

CREATE UNIQUE INDEX "CommercialPolicyVersion_version_number_key" ON "subscription"."CommercialPolicyVersion"("version_number");
CREATE INDEX "CommercialPolicyVersion_status_idx" ON "subscription"."CommercialPolicyVersion"("status");
-- Exactly one ACTIVE version (at most one at the DB; the seed makes it exactly one).
CREATE UNIQUE INDEX "CommercialPolicyVersion_one_active_key" ON "subscription"."CommercialPolicyVersion"("status") WHERE "status" = 'ACTIVE';

CREATE OR REPLACE FUNCTION "subscription"."guard_commercial_policy_version"()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'CommercialPolicyVersion is append-only (DELETE rejected)';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'CommercialPolicyVersion identity is immutable';
    END IF;
    IF (OLD."status" <> 'DRAFT' OR NEW."status" <> 'DRAFT')
       AND (NEW."content" IS DISTINCT FROM OLD."content"
            OR NEW."content_checksum" IS DISTINCT FROM OLD."content_checksum"
            OR NEW."note" IS DISTINCT FROM OLD."note") THEN
        RAISE EXCEPTION 'CommercialPolicyVersion content is immutable once it leaves DRAFT (create a new version instead)';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT ((OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE')
             OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'RETIRED')
             OR (OLD."status" = 'RETIRED' AND NEW."status" = 'ACTIVE')) THEN
        RAISE EXCEPTION 'CommercialPolicyVersion status % -> % is not allowed', OLD."status", NEW."status";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "commercial_policy_version_guard_update"
    BEFORE UPDATE ON "subscription"."CommercialPolicyVersion"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_commercial_policy_version"();

CREATE TRIGGER "commercial_policy_version_guard_delete"
    BEFORE DELETE ON "subscription"."CommercialPolicyVersion"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_commercial_policy_version"();

-- ---------------------------------------------------------------------------------------
-- CommercialPolicyAuditEvent
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."CommercialPolicyAuditEvent" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommercialPolicyAuditEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommercialPolicyAuditEvent_event_type_check" CHECK ("event_type" IN ('COMMERCIAL_POLICY_VERSION_CREATED', 'COMMERCIAL_POLICY_VERSION_ACTIVATED', 'COMMERCIAL_POLICY_VERSION_RETIRED')),
    CONSTRAINT "CommercialPolicyAuditEvent_actor_type_check" CHECK ("actor_type" IN ('user', 'system')),
    CONSTRAINT "CommercialPolicyAuditEvent_event_payload_check" CHECK (jsonb_typeof("event_payload") = 'object')
);

CREATE INDEX "CommercialPolicyAuditEvent_subject_id_created_at_id_idx" ON "subscription"."CommercialPolicyAuditEvent"("subject_id", "created_at" DESC, "id" DESC);
CREATE INDEX "CommercialPolicyAuditEvent_created_at_id_idx" ON "subscription"."CommercialPolicyAuditEvent"("created_at" DESC, "id" DESC);

CREATE OR REPLACE FUNCTION "subscription"."reject_commercial_policy_audit_event_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'CommercialPolicyAuditEvent is an append-only governance ledger (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "commercial_policy_audit_event_no_update"
    BEFORE UPDATE ON "subscription"."CommercialPolicyAuditEvent"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."reject_commercial_policy_audit_event_mutation"();

CREATE TRIGGER "commercial_policy_audit_event_no_delete"
    BEFORE DELETE ON "subscription"."CommercialPolicyAuditEvent"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."reject_commercial_policy_audit_event_mutation"();

-- ---------------------------------------------------------------------------------------
-- CommercialAuditEvent
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."CommercialAuditEvent" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL,
    -- Server-side snapshot of the actor's role keys at the time of the event.
    "actor_role_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "event_type" TEXT NOT NULL,
    "is_exception" BOOLEAN NOT NULL DEFAULT false,
    "tenant_id" UUID,
    -- What the event is about, as "<kind>:<id>" (e.g. commercial_policy_version:<uuid>).
    "subject" TEXT NOT NULL,
    -- CCP-A3 adds the FK to CommercialChangeRequest.
    "change_request_id" UUID,
    -- The policy version in force for the event.
    "policy_version_id" UUID NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "correlation_id" TEXT NOT NULL,
    -- Millisecond precision so the (created_at, id) keyset cursor round-trips exactly
    -- through a JavaScript Date.
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommercialAuditEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommercialAuditEvent_actor_type_check" CHECK ("actor_type" IN ('user', 'system')),
    CONSTRAINT "CommercialAuditEvent_user_actor_check" CHECK ("actor_type" <> 'user' OR "actor_id" IS NOT NULL),
    CONSTRAINT "CommercialAuditEvent_event_type_check" CHECK ("event_type" ~ '^[A-Z][A-Z0-9_]{2,99}$'),
    CONSTRAINT "CommercialAuditEvent_subject_check" CHECK ("subject" ~ '^[a-z][a-z0-9_]*:.+$' AND length("subject") <= 300),
    CONSTRAINT "CommercialAuditEvent_payload_check" CHECK (jsonb_typeof("payload") = 'object'),
    CONSTRAINT "CommercialAuditEvent_correlation_id_check" CHECK (length("correlation_id") BETWEEN 1 AND 200),
    CONSTRAINT "CommercialAuditEvent_policy_version_id_fkey" FOREIGN KEY ("policy_version_id")
        REFERENCES "subscription"."CommercialPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- Keyset order for the read route is (created_at DESC, id DESC); one index per filter.
CREATE INDEX "CommercialAuditEvent_created_at_id_idx" ON "subscription"."CommercialAuditEvent"("created_at" DESC, "id" DESC);
CREATE INDEX "CommercialAuditEvent_actor_id_created_at_id_idx" ON "subscription"."CommercialAuditEvent"("actor_id", "created_at" DESC, "id" DESC);
CREATE INDEX "CommercialAuditEvent_tenant_id_created_at_id_idx" ON "subscription"."CommercialAuditEvent"("tenant_id", "created_at" DESC, "id" DESC);
CREATE INDEX "CommercialAuditEvent_event_type_created_at_id_idx" ON "subscription"."CommercialAuditEvent"("event_type", "created_at" DESC, "id" DESC);
CREATE INDEX "CommercialAuditEvent_exception_created_at_id_idx" ON "subscription"."CommercialAuditEvent"("created_at" DESC, "id" DESC) WHERE "is_exception";

CREATE OR REPLACE FUNCTION "subscription"."reject_commercial_audit_event_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'CommercialAuditEvent is an append-only commercial audit ledger (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "commercial_audit_event_no_update"
    BEFORE UPDATE ON "subscription"."CommercialAuditEvent"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."reject_commercial_audit_event_mutation"();

CREATE TRIGGER "commercial_audit_event_no_delete"
    BEFORE DELETE ON "subscription"."CommercialAuditEvent"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."reject_commercial_audit_event_mutation"();

-- ---------------------------------------------------------------------------------------
-- Seed: policy v1 (ACTIVE) = Charter §7 (D5) values, as data. Units: basis points,
-- USD minor units, days, hours. Canonical-JSON SHA-256 recomputed by
-- libs/subscription/src/tests/commercial-policy.spec.ts.
-- ---------------------------------------------------------------------------------------
-- commercial-policy-v1-content
INSERT INTO "subscription"."CommercialPolicyVersion"
    ("id", "version_number", "status", "content", "content_checksum", "note", "created_by", "created_at", "activated_by", "activated_at")
VALUES (
    '019a0000-0000-7000-8000-0000000cc201',
    1,
    'ACTIVE',
    '{"approval_expiry_hours":72,"credit_escalation_threshold_minor":50000,"currency":"USD","discount_escalation_threshold_bps":2000,"format_version":1,"past_due_grace_days":7,"support_extension_cumulative_max_days":30,"support_extension_cumulative_window_days":365,"support_extension_frequency_window_days":90,"support_extension_max_days":14}'::jsonb,
    'bdc36ef2f1cde82945139efffdac03c999d98a026113b4dde6e13f0ce05752f5',
    'Seed: Charter section 7 (Decision D5) initial commercial policy v1',
    NULL,
    CURRENT_TIMESTAMP,
    NULL,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "subscription"."CommercialPolicyAuditEvent"
    ("id", "actor_id", "actor_type", "event_type", "subject_id", "event_payload", "created_at")
VALUES (
    '019a0000-0000-7000-8000-0000000cc202',
    NULL,
    'system',
    'COMMERCIAL_POLICY_VERSION_ACTIVATED',
    '019a0000-0000-7000-8000-0000000cc201',
    '{"version_number":1,"content_checksum":"bdc36ef2f1cde82945139efffdac03c999d98a026113b4dde6e13f0ce05752f5","previous_active_version_id":null,"source":"migration_seed"}'::jsonb,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "subscription"."CommercialAuditEvent"
    ("id", "actor_id", "actor_type", "actor_role_keys", "event_type", "is_exception", "tenant_id", "subject", "change_request_id", "policy_version_id", "payload", "correlation_id", "created_at")
VALUES (
    '019a0000-0000-7000-8000-0000000cc203',
    NULL,
    'system',
    ARRAY[]::TEXT[],
    'COMMERCIAL_POLICY_VERSION_ACTIVATED',
    false,
    NULL,
    'commercial_policy_version:019a0000-0000-7000-8000-0000000cc201',
    NULL,
    '019a0000-0000-7000-8000-0000000cc201',
    '{"version_number":1,"content_checksum":"bdc36ef2f1cde82945139efffdac03c999d98a026113b4dde6e13f0ce05752f5","source":"migration_seed"}'::jsonb,
    'migration:20261024180000_ccp_a2_commercial_audit_policy',
    CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;
