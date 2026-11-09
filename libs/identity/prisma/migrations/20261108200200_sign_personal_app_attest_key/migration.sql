-- Aramo Sign Apple Platform Go-Live (LOCKED) R-9 / W2 — iPhone native signup
-- integrity (App Attest). Additive on the table 20261022120000_sign_personal_free
-- created (that migration is merged and immutable).

-- The App Attest key id of a `client: "ios"` start: the lowercase hex SHA-256 of
-- the attested credential public key. NULL for web and android starts. UNIQUE so a
-- key id (one attestation) is accepted once: a replayed attestation is refused.
ALTER TABLE "identity"."PersonalSignupRequest" ADD COLUMN "attest_key_id" TEXT;
CREATE UNIQUE INDEX "PersonalSignupRequest_attest_key_id_key" ON "identity"."PersonalSignupRequest"("attest_key_id");
