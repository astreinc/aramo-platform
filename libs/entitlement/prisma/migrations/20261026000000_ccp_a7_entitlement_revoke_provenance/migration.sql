-- CCP-A7 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A7; Charter D1; Conversion
-- Rule C-20; Successor Record v1.2 §3.6) — entitlement provenance, governed revoke and the
-- resurrection guard. Value list and recon: doc/ccp/slices/CCP-A7-pre-execution.md §2.
--
-- ADDITIVE ONLY (no column renamed, no row removed):
--   1. TenantEntitlement gains grant provenance (granted_source, granted_by, change_request_id)
--      and a revoke (revoked_at, revoked_by, revoke_change_request_id). A revoked row is KEPT;
--      the readers (EntitlementRepository) count only rows with revoked_at IS NULL.
--      Every pre-A7 row is backfilled granted_source = MIGRATION (provenance unknown, and
--      non-commercial): explicit history, written by an UPDATE. There is NO column default
--      (CCP-R1, TD-A7-3): every writer names its source, and an INSERT that omits it fails
--      NOT NULL. Nothing falls back to MIGRATION.
--   2. granted_source is a closed set: the Part IV values MANUAL, PLAN, PROMOTION, MIGRATION
--      (kept, none renamed) plus PROVISIONING (D4 default bundle, seed reconcile) and SIGNUP
--      (C-20 signup grant). The commercial values carry a change request, the others never.
--   3. TenantEntitlementEvent (new, append-only): the ledger. An AFTER trigger records every
--      grant, revoke, re-grant and removal from every writer, raw SQL included; the
--      repository records RESURRECTION_REFUSED when an ungoverned grant meets a revoke.
--   4. The resurrection guard (BEFORE UPDATE OR DELETE): a revoke is cleared only by a governed
--      re-grant (a NEW change request, commercial source); a revoked row cannot be deleted; a
--      revoke leaves the grant provenance untouched; nothing else updates a row.
--
-- No bypass: ENABLE ALWAYS keeps the triggers firing under session_replication_role.
-- REPLAY-SAFE: IF NOT EXISTS, DROP CONSTRAINT / TRIGGER IF EXISTS, CREATE OR REPLACE FUNCTION,
-- NOT EXISTS on the ledger backfill.
-- Splitter-safe (the ROLES-1 / CCP-A9 convention): every function body is a SINGLE-QUOTED
-- one-line string (no dollar quoting, no statement terminator at a line end inside a body,
-- no double hyphen inside a body).
--
-- Compensating migration (documented, not shipped; doc/ccp/slices/CCP-A7-acceptance.md §8):
-- RAISE if any row has revoked_at set or a commercial granted_source; then drop the triggers,
-- the functions, TenantEntitlementEvent, the constraints, the index and the six columns.
-- Design approval is not production migration authority (ruling A0-C15).

-- 1. Provenance and revoke columns
-- CCP-R1 (TD-A7-3): add nullable, backfill the pre-A7 rows explicitly, then NOT NULL with no
-- default. DROP DEFAULT also clears the default from a database that applied the pre-R1 text.
ALTER TABLE "entitlement"."TenantEntitlement" ADD COLUMN IF NOT EXISTS "granted_source" TEXT;
UPDATE "entitlement"."TenantEntitlement" SET "granted_source" = 'MIGRATION' WHERE "granted_source" IS NULL;
ALTER TABLE "entitlement"."TenantEntitlement" ALTER COLUMN "granted_source" SET NOT NULL;
ALTER TABLE "entitlement"."TenantEntitlement" ALTER COLUMN "granted_source" DROP DEFAULT;
ALTER TABLE "entitlement"."TenantEntitlement" ADD COLUMN IF NOT EXISTS "granted_by" UUID;
ALTER TABLE "entitlement"."TenantEntitlement" ADD COLUMN IF NOT EXISTS "change_request_id" UUID;
ALTER TABLE "entitlement"."TenantEntitlement" ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMPTZ(6);
ALTER TABLE "entitlement"."TenantEntitlement" ADD COLUMN IF NOT EXISTS "revoked_by" UUID;
ALTER TABLE "entitlement"."TenantEntitlement" ADD COLUMN IF NOT EXISTS "revoke_change_request_id" UUID;

-- 2. The closed provenance set; commercial iff governed; a revoke is complete and governed
ALTER TABLE "entitlement"."TenantEntitlement" DROP CONSTRAINT IF EXISTS "TenantEntitlement_granted_source_check";
ALTER TABLE "entitlement"."TenantEntitlement" ADD CONSTRAINT "TenantEntitlement_granted_source_check"
    CHECK ("granted_source" IN ('MANUAL', 'PLAN', 'PROMOTION', 'MIGRATION', 'PROVISIONING', 'SIGNUP'));
ALTER TABLE "entitlement"."TenantEntitlement" DROP CONSTRAINT IF EXISTS "TenantEntitlement_commercial_source_check";
ALTER TABLE "entitlement"."TenantEntitlement" ADD CONSTRAINT "TenantEntitlement_commercial_source_check"
    CHECK (("granted_source" IN ('MANUAL', 'PLAN', 'PROMOTION')) = ("change_request_id" IS NOT NULL));
ALTER TABLE "entitlement"."TenantEntitlement" DROP CONSTRAINT IF EXISTS "TenantEntitlement_revoke_check";
ALTER TABLE "entitlement"."TenantEntitlement" ADD CONSTRAINT "TenantEntitlement_revoke_check"
    CHECK ((("revoked_at" IS NULL) = ("revoked_by" IS NULL)) AND (("revoked_at" IS NULL) = ("revoke_change_request_id" IS NULL)));

-- The Intelligence REPLACE read (every active holder of one capability).
CREATE INDEX IF NOT EXISTS "TenantEntitlement_capability_active_idx" ON "entitlement"."TenantEntitlement"("capability", "tenant_id") WHERE "revoked_at" IS NULL;

-- 3. The ledger
CREATE TABLE IF NOT EXISTS "entitlement"."TenantEntitlementEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "capability" "entitlement"."Capability" NOT NULL,
    "event_type" TEXT NOT NULL,
    "granted_source" TEXT,
    "actor_id" UUID,
    "change_request_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantEntitlementEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TenantEntitlementEvent_event_type_check" CHECK ("event_type" IN ('GRANTED', 'REVOKED', 'REGRANTED', 'RESURRECTION_REFUSED', 'REMOVED'))
);
CREATE INDEX IF NOT EXISTS "TenantEntitlementEvent_tenant_id_capability_occurred_at_idx" ON "entitlement"."TenantEntitlementEvent"("tenant_id", "capability", "occurred_at");

-- The ledger opens with one GRANTED (MIGRATION) event per pre-A7 row.
INSERT INTO "entitlement"."TenantEntitlementEvent" ("tenant_id", "capability", "event_type", "granted_source", "occurred_at")
SELECT e."tenant_id", e."capability", 'GRANTED', e."granted_source", e."granted_at"
  FROM "entitlement"."TenantEntitlement" e
 WHERE NOT EXISTS (SELECT 1 FROM "entitlement"."TenantEntitlementEvent" v WHERE v."tenant_id" = e."tenant_id" AND v."capability" = e."capability");

CREATE OR REPLACE FUNCTION "entitlement".ccp_a7_reject_entitlement_event_mutation() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''TenantEntitlementEvent is append-only (% rejected)'', TG_OP; END';

DROP TRIGGER IF EXISTS "ccp_a7_entitlement_event_no_update" ON "entitlement"."TenantEntitlementEvent";
CREATE TRIGGER "ccp_a7_entitlement_event_no_update" BEFORE UPDATE ON "entitlement"."TenantEntitlementEvent" FOR EACH ROW EXECUTE FUNCTION "entitlement".ccp_a7_reject_entitlement_event_mutation();
DROP TRIGGER IF EXISTS "ccp_a7_entitlement_event_no_delete" ON "entitlement"."TenantEntitlementEvent";
CREATE TRIGGER "ccp_a7_entitlement_event_no_delete" BEFORE DELETE ON "entitlement"."TenantEntitlementEvent" FOR EACH ROW EXECUTE FUNCTION "entitlement".ccp_a7_reject_entitlement_event_mutation();

-- 4. The resurrection guard
CREATE OR REPLACE FUNCTION "entitlement".ccp_a7_guard_tenant_entitlement() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF TG_OP = ''DELETE'' THEN IF OLD."revoked_at" IS NOT NULL THEN RAISE EXCEPTION ''entitlement_revoke_permanent: a revoked TenantEntitlement row cannot be deleted (only a governed re-grant restores it)'' USING ERRCODE = ''integrity_constraint_violation''; END IF; RETURN OLD; END IF; IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR NEW."capability" IS DISTINCT FROM OLD."capability" THEN RAISE EXCEPTION ''TenantEntitlement tenant_id and capability are immutable''; END IF; IF OLD."revoked_at" IS NULL AND NEW."revoked_at" IS NOT NULL THEN IF NEW."granted_source" IS DISTINCT FROM OLD."granted_source" OR NEW."granted_by" IS DISTINCT FROM OLD."granted_by" OR NEW."change_request_id" IS DISTINCT FROM OLD."change_request_id" OR NEW."granted_at" IS DISTINCT FROM OLD."granted_at" THEN RAISE EXCEPTION ''TenantEntitlement: a revoke leaves the grant provenance unchanged''; END IF; RETURN NEW; END IF; IF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS NULL THEN IF NEW."change_request_id" IS NULL OR NEW."change_request_id" IS NOT DISTINCT FROM OLD."change_request_id" OR NEW."change_request_id" IS NOT DISTINCT FROM OLD."revoke_change_request_id" OR NEW."granted_source" NOT IN (''MANUAL'', ''PLAN'') THEN RAISE EXCEPTION ''entitlement_resurrection: a revoke is cleared only by a governed re-grant (a new change request)'' USING ERRCODE = ''integrity_constraint_violation''; END IF; RETURN NEW; END IF; RAISE EXCEPTION ''TenantEntitlement changes only by a governed revoke or a governed re-grant''; END';

DROP TRIGGER IF EXISTS "ccp_a7_tenant_entitlement_guard" ON "entitlement"."TenantEntitlement";
CREATE TRIGGER "ccp_a7_tenant_entitlement_guard" BEFORE UPDATE OR DELETE ON "entitlement"."TenantEntitlement" FOR EACH ROW EXECUTE FUNCTION "entitlement".ccp_a7_guard_tenant_entitlement();

CREATE OR REPLACE FUNCTION "entitlement".ccp_a7_record_tenant_entitlement_event() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF TG_OP = ''INSERT'' THEN INSERT INTO "entitlement"."TenantEntitlementEvent" ("tenant_id", "capability", "event_type", "granted_source", "actor_id", "change_request_id") VALUES (NEW."tenant_id", NEW."capability", ''GRANTED'', NEW."granted_source", NEW."granted_by", NEW."change_request_id"); ELSIF TG_OP = ''DELETE'' THEN INSERT INTO "entitlement"."TenantEntitlementEvent" ("tenant_id", "capability", "event_type", "granted_source") VALUES (OLD."tenant_id", OLD."capability", ''REMOVED'', OLD."granted_source"); ELSIF OLD."revoked_at" IS NULL AND NEW."revoked_at" IS NOT NULL THEN INSERT INTO "entitlement"."TenantEntitlementEvent" ("tenant_id", "capability", "event_type", "granted_source", "actor_id", "change_request_id") VALUES (NEW."tenant_id", NEW."capability", ''REVOKED'', NEW."granted_source", NEW."revoked_by", NEW."revoke_change_request_id"); ELSIF OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS NULL THEN INSERT INTO "entitlement"."TenantEntitlementEvent" ("tenant_id", "capability", "event_type", "granted_source", "actor_id", "change_request_id") VALUES (NEW."tenant_id", NEW."capability", ''REGRANTED'', NEW."granted_source", NEW."granted_by", NEW."change_request_id"); END IF; RETURN NULL; END';

DROP TRIGGER IF EXISTS "ccp_a7_tenant_entitlement_ledger" ON "entitlement"."TenantEntitlement";
CREATE TRIGGER "ccp_a7_tenant_entitlement_ledger" AFTER INSERT OR UPDATE OR DELETE ON "entitlement"."TenantEntitlement" FOR EACH ROW EXECUTE FUNCTION "entitlement".ccp_a7_record_tenant_entitlement_event();

ALTER TABLE "entitlement"."TenantEntitlement" ENABLE ALWAYS TRIGGER "ccp_a7_tenant_entitlement_guard";
ALTER TABLE "entitlement"."TenantEntitlement" ENABLE ALWAYS TRIGGER "ccp_a7_tenant_entitlement_ledger";
ALTER TABLE "entitlement"."TenantEntitlementEvent" ENABLE ALWAYS TRIGGER "ccp_a7_entitlement_event_no_update";
ALTER TABLE "entitlement"."TenantEntitlementEvent" ENABLE ALWAYS TRIGGER "ccp_a7_entitlement_event_no_delete";

COMMENT ON TABLE "entitlement"."TenantEntitlementEvent" IS 'CCP-A7. Append-only ledger of every entitlement grant, revoke, re-grant, removal and refused resurrection.';
