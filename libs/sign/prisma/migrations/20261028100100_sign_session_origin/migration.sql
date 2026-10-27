-- Aramo-Sign-Unified-Product-Amendment-M-A5-Recipient-Kinds-Hosted-Self-Signing-v1_0-LOCKED
-- §3, §4, §5 — where a signing session came from, who hosted it, who self-signed.
-- ADDITIVE ONLY. Legacy sessions keep origin NULL and are never backfilled with a
-- guess. splitDdl-safe: no semicolons in comment lines.

ALTER TABLE "sign"."SigningSession" ADD COLUMN "origin" TEXT;
ALTER TABLE "sign"."SigningSession" ADD COLUMN "host_user_id" UUID;
ALTER TABLE "sign"."SigningSession" ADD COLUMN "authenticated_user_id" UUID;
ALTER TABLE "sign"."SigningSession"
  ADD CONSTRAINT "SigningSession_origin_check" CHECK ("origin" IS NULL OR "origin" IN ('LINK', 'INBOX', 'HOSTED', 'SELF'));
-- A HOSTED session always names its host, and only a HOSTED session has one.
ALTER TABLE "sign"."SigningSession"
  ADD CONSTRAINT "SigningSession_host_user_check" CHECK (
    ("origin" IS NOT DISTINCT FROM 'HOSTED' AND "host_user_id" IS NOT NULL)
    OR ("origin" IS DISTINCT FROM 'HOSTED' AND "host_user_id" IS NULL)
  );
-- A SELF session always names the authenticated signer, and only a SELF session has one.
ALTER TABLE "sign"."SigningSession"
  ADD CONSTRAINT "SigningSession_authenticated_user_check" CHECK (
    ("origin" IS NOT DISTINCT FROM 'SELF' AND "authenticated_user_id" IS NOT NULL)
    OR ("origin" IS DISTINCT FROM 'SELF' AND "authenticated_user_id" IS NULL)
  );

-- §3.4 — in a hosted session the signer confirms their name with the disclosure.
-- Kept on the acceptance row (the ledger carries only its sha256), so the signer's
-- name field can use the attested name.
ALTER TABLE "sign"."SignerDisclosureAcceptance" ADD COLUMN "attested_name" TEXT;
ALTER TABLE "sign"."SignerDisclosureAcceptance"
  ADD CONSTRAINT "SignerDisclosureAcceptance_attested_name_check" CHECK ("attested_name" IS NULL OR char_length("attested_name") BETWEEN 1 AND 200);
