-- Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED (SHA-256 fa0c08de…) — identifier migration esign → sign.
-- Guarded and idempotent: a second run is a no-op. splitDdl-safe: no semicolons in comment lines.
-- §3.2/§3.3 — the auth consumer esign becomes sign. Live refresh tokens issued to
-- the esign consumer are revoked (their holders sign in again once). Historical,
-- already-revoked rows keep their recorded consumer (history is not rewritten).
-- Postcondition: no unrevoked refresh token carries consumer esign.
UPDATE "auth_storage"."RefreshToken" SET "revoked_at" = now(), "updated_at" = now()
 WHERE "consumer_type" = 'esign' AND "revoked_at" IS NULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "auth_storage"."RefreshToken" WHERE "consumer_type" = 'esign' AND "revoked_at" IS NULL) THEN
    RAISE EXCEPTION 'sign naming: live esign refresh tokens remain';
  END IF;
END
$$;
