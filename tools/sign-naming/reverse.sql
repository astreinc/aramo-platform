-- Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED §3.5 — the REVERSIBLE
-- FORWARD MIGRATION (sign → esign). Run ONLY at the rollback decision point,
-- inside the write-frozen window, with the pre-rename images ready to start.
-- One transaction (psql --single-transaction): every step is guarded and the
-- whole script either completes or leaves the database unchanged.
--
-- After it: the schema is esign again, the enum value, role and scope keys, Sign
-- API permission arrays and subscription keys carry esign names, the documents
-- erasure guard names esign again, and the ledger is back to the libs/esign paths
-- with the six naming migrations un-recorded, so a later forward run (the
-- guarded re-key, then the six naming migrations) can repeat the cutover.
-- Not reversed: refresh tokens revoked by the forward run stay revoked (users
-- sign in again), and historical rows that were never rewritten stay as they are.

DO $$
BEGIN
  IF to_regnamespace('sign') IS NULL OR to_regnamespace('esign') IS NOT NULL THEN
    RAISE EXCEPTION 'sign naming reverse: expected schema sign alone (refused, nothing changed)';
  END IF;
  IF (SELECT count(*) FROM public._local_migrations WHERE name LIKE 'libs/esign/prisma/migrations/%') <> 0 THEN
    RAISE EXCEPTION 'sign naming reverse: legacy ledger rows already present (refused, nothing changed)';
  END IF;
END
$$;

-- Sign schema contents, then the schema itself.
UPDATE "sign"."SignApplication"
   SET "requested_permissions" = ARRAY(SELECT regexp_replace(p, '^sign:', 'esign:') FROM unnest("requested_permissions") WITH ORDINALITY AS u(p, i) ORDER BY i),
       "delegation_profile"    = ARRAY(SELECT regexp_replace(p, '^sign:', 'esign:') FROM unnest("delegation_profile") WITH ORDINALITY AS u(p, i) ORDER BY i);
UPDATE "sign"."SignInstallation"
   SET "granted_permissions" = ARRAY(SELECT regexp_replace(p, '^sign:', 'esign:') FROM unnest("granted_permissions") WITH ORDINALITY AS u(p, i) ORDER BY i);
UPDATE "sign"."SignAccessToken"
   SET "scopes" = ARRAY(SELECT regexp_replace(p, '^sign:', 'esign:') FROM unnest("scopes") WITH ORDINALITY AS u(p, i) ORDER BY i);
UPDATE "sign"."SignWebhookSubscription"
   SET "event_types" = ARRAY(SELECT regexp_replace(e, '^sign\.', 'esign.') FROM unnest("event_types") WITH ORDINALITY AS u(e, i) ORDER BY i);
UPDATE "sign"."SignWebhookSubscription"
   SET "target_url" = replace("target_url", '/v1/integrations/sign/events', '/v1/integrations/esign/events')
 WHERE "internal" = true AND "tenant_id" IS NULL AND "target_url" LIKE '%/v1/integrations/sign/events';
ALTER TABLE "sign"."SignInstallation" DROP CONSTRAINT IF EXISTS "SignInstallation_role_check";
ALTER TABLE "sign"."SignRoleMapping" DROP CONSTRAINT IF EXISTS "SignRoleMapping_sign_role_check";
UPDATE "sign"."SignInstallation" SET "integration_role" = 'esign_' || substr("integration_role", 6) WHERE "integration_role" LIKE 'sign\_%';
UPDATE "sign"."SignRoleMapping" SET "sign_role" = 'esign_' || substr("sign_role", 6) WHERE "sign_role" LIKE 'sign\_%';
UPDATE "sign"."SignApplication"
   SET "assertable_roles" = ARRAY(SELECT regexp_replace(r, '^sign_', 'esign_') FROM unnest("assertable_roles") WITH ORDINALITY AS u(r, i) ORDER BY i);
ALTER TABLE "sign"."SignInstallation" ADD CONSTRAINT "SignInstallation_role_check"
  CHECK ("integration_role" IS NULL OR "integration_role" IN ('esign_admin', 'esign_sender', 'esign_viewer'));
ALTER TABLE "sign"."SignRoleMapping" ADD CONSTRAINT "SignRoleMapping_sign_role_check"
  CHECK ("sign_role" IN ('esign_admin', 'esign_sender', 'esign_viewer'));
ALTER SCHEMA "sign" RENAME TO "esign";

-- Documents erasure guard: the pre-rename body (20261016180200, verbatim).
CREATE OR REPLACE FUNCTION documents.reject_document_event_mutation()
RETURNS TRIGGER AS $$
DECLARE
  v_ids UUID[];
BEGIN
  IF TG_OP = 'DELETE' AND COALESCE(current_setting('app.talent_erasure_run', true), '') <> '' THEN
    v_ids := consent.s2_authorized_record_ids(OLD.tenant_id);
    IF v_ids IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM documents."DocumentAssociation" da
          WHERE da.document_id = OLD.document_id AND da.tenant_id = OLD.tenant_id
            AND da.resource_type = 'TALENT' AND da.resource_id = ANY (v_ids))
       AND NOT EXISTS (
         SELECT 1 FROM documents."DocumentAssociation" da
          WHERE da.document_id = OLD.document_id
            AND da.resource_type = 'TALENT' AND da.resource_id <> ALL (v_ids))
       AND NOT EXISTS (
         SELECT 1 FROM documents."DocumentArtifact" a
          WHERE a.document_id = OLD.document_id
            AND (a.legal_hold = true OR (a.retain_until IS NOT NULL AND a.retain_until > now())))
       AND NOT EXISTS (
         SELECT 1 FROM esign."EnvelopeDocument" ed WHERE ed.document_ref = OLD.document_id)
    THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'DocumentEvent is append-only (DOC-1a): UPDATE and DELETE are rejected';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Subscription keys.
UPDATE "subscription"."PlanAllowance"  SET "allowance_key" = 'esign.' || substr("allowance_key", 6) WHERE "allowance_key" LIKE 'sign.%';
UPDATE "subscription"."AllowanceUsage" SET "allowance_key" = 'esign.' || substr("allowance_key", 6) WHERE "allowance_key" LIKE 'sign.%';
UPDATE "subscription"."PlanCapacity"   SET "capacity_key"  = 'esign.' || substr("capacity_key", 6)  WHERE "capacity_key" LIKE 'sign.%';
UPDATE "subscription"."CapacityUsage"  SET "capacity_key"  = 'esign.' || substr("capacity_key", 6)  WHERE "capacity_key" LIKE 'sign.%';
UPDATE "subscription"."PlanFeature"    SET "feature_key"   = 'esign.' || substr("feature_key", 6)   WHERE "feature_key" LIKE 'sign.%';

-- Identity keys and the entitlement enum value.
UPDATE "identity"."Role"  SET "key" = 'esign_' || substr("key", 6), "updated_at" = now() WHERE "key" LIKE 'sign\_%';
UPDATE "identity"."Scope" SET "key" = 'esign:' || substr("key", 6) WHERE "key" LIKE 'sign:%';
ALTER TYPE "entitlement"."Capability" RENAME VALUE 'sign' TO 'esign';

-- Ledger: un-record the six naming migrations, then restore the legacy paths.
DELETE FROM public._local_migrations WHERE name IN (
  'libs/entitlement/prisma/migrations/20261020130000_sign_naming_capability/',
  'libs/identity/prisma/migrations/20261020130100_sign_naming_role_scope_keys/',
  'libs/auth-storage/prisma/migrations/20261020130200_sign_naming_consumer/',
  'libs/subscription/prisma/migrations/20261020130300_sign_naming_keys/',
  'libs/sign/prisma/migrations/20261020130400_sign_naming_schema/',
  'libs/documents/prisma/migrations/20261020130500_sign_naming_erasure_guard/'
);
UPDATE public._local_migrations
   SET name = 'libs/esign/prisma/migrations/' || substr(name, length('libs/sign/prisma/migrations/') + 1)
 WHERE name LIKE 'libs/sign/prisma/migrations/%';

DO $$
BEGIN
  IF to_regnamespace('esign') IS NULL OR to_regnamespace('sign') IS NOT NULL
     OR EXISTS (SELECT 1 FROM "identity"."Role" WHERE "key" LIKE 'sign\_%')
     OR EXISTS (SELECT 1 FROM "identity"."Scope" WHERE "key" LIKE 'sign:%')
     OR EXISTS (SELECT 1 FROM public._local_migrations WHERE name LIKE 'libs/sign/prisma/migrations/%') THEN
    RAISE EXCEPTION 'sign naming reverse: postcondition failed';
  END IF;
END
$$;
