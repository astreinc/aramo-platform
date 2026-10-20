-- Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED (SHA-256 fa0c08de…) — identifier migration esign → sign.
-- Guarded and idempotent: a second run is a no-op. splitDdl-safe: no semicolons in comment lines.
-- §3.2 — role keys esign_* become sign_* and scope keys esign:* become sign:*.
-- Grants (RoleScope, UserTenantMembershipRole) link by UUID and are unaffected.
-- Precondition: no row already carries the target key (a partial or conflicting
-- state is refused, not merged). Postcondition: no esign_ role and no esign: scope remain.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "identity"."Role" o JOIN "identity"."Role" n ON n."key" = 'sign_' || substr(o."key", 7) WHERE o."key" LIKE 'esign\_%') THEN
    RAISE EXCEPTION 'sign naming: a sign_ role already exists beside its esign_ source (partial state refused)';
  END IF;
  IF EXISTS (SELECT 1 FROM "identity"."Scope" o JOIN "identity"."Scope" n ON n."key" = 'sign:' || substr(o."key", 7) WHERE o."key" LIKE 'esign:%') THEN
    RAISE EXCEPTION 'sign naming: a sign: scope already exists beside its esign: source (partial state refused)';
  END IF;
  UPDATE "identity"."Role" SET "key" = 'sign_' || substr("key", 7), "updated_at" = now() WHERE "key" LIKE 'esign\_%';
  UPDATE "identity"."Scope" SET "key" = 'sign:' || substr("key", 7) WHERE "key" LIKE 'esign:%';
  IF EXISTS (SELECT 1 FROM "identity"."Role" WHERE "key" LIKE 'esign\_%') OR EXISTS (SELECT 1 FROM "identity"."Scope" WHERE "key" LIKE 'esign:%') THEN
    RAISE EXCEPTION 'sign naming: esign role or scope keys remain';
  END IF;
END
$$;
