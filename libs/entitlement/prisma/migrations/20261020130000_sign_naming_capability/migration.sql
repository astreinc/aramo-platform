-- Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED (SHA-256 fa0c08de…) — identifier migration esign → sign.
-- Guarded and idempotent: a second run is a no-op. splitDdl-safe: no semicolons in comment lines.
-- §3.2 — the tenant capability enum value esign becomes sign. TenantEntitlement
-- rows hold the enum value, so they follow the rename automatically.
-- Precondition: label esign present and sign absent (rename). Already renamed: no-op.
-- Postcondition: label sign present, label esign absent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
             WHERE n.nspname = 'entitlement' AND t.typname = 'Capability' AND e.enumlabel = 'esign')
     AND NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
             WHERE n.nspname = 'entitlement' AND t.typname = 'Capability' AND e.enumlabel = 'sign') THEN
    ALTER TYPE "entitlement"."Capability" RENAME VALUE 'esign' TO 'sign';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
             WHERE n.nspname = 'entitlement' AND t.typname = 'Capability' AND e.enumlabel = 'esign') THEN
    RAISE EXCEPTION 'sign naming: entitlement.Capability still carries esign (both labels present?)';
  END IF;
END
$$;
