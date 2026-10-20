-- Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED (SHA-256 fa0c08de…) — identifier migration esign → sign.
-- Guarded and idempotent: a second run is a no-op. splitDdl-safe: no semicolons in comment lines.
-- §3.2 — the Sign schema esign becomes sign. Tables, indexes, sequences, types,
-- constraints, triggers and the schema's own functions move with the schema
-- (the recon found no grants, views or default privileges on it, and the
-- rehearsal re-verifies from the catalog). This migration touches ONLY the Sign
-- schema, so the Sign module's own integration specs replay it unchanged.
-- Integration contract (§3.6): the Sign API permission arrays move to sign:* and
-- the operator-created first-party internal subscription follows the renamed ATS
-- receiver path. Tenant-configured URLs, delivered or dead outbox and delivery
-- rows, and the append-only SignatureEvent chain are historical and NOT rewritten.
-- Precondition: exactly one of the two schema names exists.
-- Postcondition: sign exists, esign does not, no esign: permission remains.
DO $$
BEGIN
  IF to_regnamespace('esign') IS NOT NULL AND to_regnamespace('sign') IS NOT NULL THEN
    RAISE EXCEPTION 'sign naming: both schemas esign and sign exist (partial state refused)';
  END IF;
  IF to_regnamespace('esign') IS NOT NULL THEN
    ALTER SCHEMA "esign" RENAME TO "sign";
  END IF;
  IF to_regnamespace('sign') IS NULL THEN
    RAISE EXCEPTION 'sign naming: schema sign missing after rename';
  END IF;
END
$$;
-- Sign role values (the integration role, mapped Sign roles and assertable roles)
-- move to sign_*, with the two CHECK constraints that pin them. External roles are
-- tenant-supplied and untouched.
ALTER TABLE "sign"."SignInstallation" DROP CONSTRAINT IF EXISTS "SignInstallation_role_check";
ALTER TABLE "sign"."SignRoleMapping" DROP CONSTRAINT IF EXISTS "SignRoleMapping_sign_role_check";
UPDATE "sign"."SignInstallation" SET "integration_role" = 'sign_' || substr("integration_role", 7) WHERE "integration_role" LIKE 'esign\_%';
UPDATE "sign"."SignRoleMapping" SET "sign_role" = 'sign_' || substr("sign_role", 7) WHERE "sign_role" LIKE 'esign\_%';
UPDATE "sign"."SignApplication"
   SET "assertable_roles" = ARRAY(SELECT regexp_replace(r, '^esign_', 'sign_') FROM unnest("assertable_roles") WITH ORDINALITY AS u(r, i) ORDER BY i)
 WHERE EXISTS (SELECT 1 FROM unnest("assertable_roles") AS x(r) WHERE r LIKE 'esign\_%');
ALTER TABLE "sign"."SignInstallation" ADD CONSTRAINT "SignInstallation_role_check"
  CHECK ("integration_role" IS NULL OR "integration_role" IN ('sign_admin', 'sign_sender', 'sign_viewer'));
ALTER TABLE "sign"."SignRoleMapping" ADD CONSTRAINT "SignRoleMapping_sign_role_check"
  CHECK ("sign_role" IN ('sign_admin', 'sign_sender', 'sign_viewer'));
UPDATE "sign"."SignApplication"
   SET "requested_permissions" = ARRAY(SELECT regexp_replace(p, '^esign:', 'sign:') FROM unnest("requested_permissions") WITH ORDINALITY AS u(p, i) ORDER BY i),
       "delegation_profile"    = ARRAY(SELECT regexp_replace(p, '^esign:', 'sign:') FROM unnest("delegation_profile") WITH ORDINALITY AS u(p, i) ORDER BY i)
 WHERE EXISTS (SELECT 1 FROM unnest("requested_permissions" || "delegation_profile") AS x(p) WHERE p LIKE 'esign:%');
UPDATE "sign"."SignInstallation"
   SET "granted_permissions" = ARRAY(SELECT regexp_replace(p, '^esign:', 'sign:') FROM unnest("granted_permissions") WITH ORDINALITY AS u(p, i) ORDER BY i)
 WHERE EXISTS (SELECT 1 FROM unnest("granted_permissions") AS x(p) WHERE p LIKE 'esign:%');
UPDATE "sign"."SignAccessToken"
   SET "scopes" = ARRAY(SELECT regexp_replace(p, '^esign:', 'sign:') FROM unnest("scopes") WITH ORDINALITY AS u(p, i) ORDER BY i)
 WHERE EXISTS (SELECT 1 FROM unnest("scopes") AS x(p) WHERE p LIKE 'esign:%');
UPDATE "sign"."SignWebhookSubscription"
   SET "event_types" = ARRAY(SELECT regexp_replace(e, '^esign\.', 'sign.') FROM unnest("event_types") WITH ORDINALITY AS u(e, i) ORDER BY i)
 WHERE EXISTS (SELECT 1 FROM unnest("event_types") AS x(e) WHERE e LIKE 'esign.%');
UPDATE "sign"."SignWebhookSubscription"
   SET "target_url" = replace("target_url", '/v1/integrations/esign/events', '/v1/integrations/sign/events')
 WHERE "internal" = true AND "tenant_id" IS NULL AND "target_url" LIKE '%/v1/integrations/esign/events';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "sign"."SignApplication", unnest("requested_permissions" || "delegation_profile") AS x(p) WHERE p LIKE 'esign:%')
     OR EXISTS (SELECT 1 FROM "sign"."SignInstallation", unnest("granted_permissions") AS x(p) WHERE p LIKE 'esign:%')
     OR EXISTS (SELECT 1 FROM "sign"."SignAccessToken", unnest("scopes") AS x(p) WHERE p LIKE 'esign:%')
     OR EXISTS (SELECT 1 FROM "sign"."SignApplication", unnest("assertable_roles") AS x(r) WHERE r LIKE 'esign\_%') THEN
    RAISE EXCEPTION 'sign naming: esign: permissions or esign_ roles remain in the Sign API tables';
  END IF;
END
$$;
