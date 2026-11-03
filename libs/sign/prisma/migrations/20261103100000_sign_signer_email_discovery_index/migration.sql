-- Aramo Sign W2 — inbox discovery (Aramo-Sign-W2-Inbox-Discovery-Gate5-Plan-and-Amendment-v1_0-LOCKED
-- §A3.1 rule 2, §A4 Schema). ADDITIVE, INDEX ONLY: no table, no column, no returned shape change.
-- splitDdl-safe: no semicolons in comment lines.
--
-- The inbox read matches a signed-in account's current email against the recipient email
-- of every organization (normalized as lower(btrim(email)), the same rule every comparison
-- uses). Recipient emails are stored trimmed with their case kept, so a plain index on
-- email cannot serve the match. This functional index, partial on the two kinds that are
-- emailed a signing link (SIGNER and WITNESS), keeps that read off a full Signer scan.
-- Copy recipients and in-person signers are never discovered and are left out.

CREATE INDEX IF NOT EXISTS "Signer_email_discovery_idx"
  ON "sign"."Signer" (lower(btrim("email")))
  WHERE "recipient_kind" IN ('SIGNER', 'WITNESS');
