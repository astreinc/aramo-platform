-- DOC-6 (R-6-2) — seed the OFFER_LETTER SYSTEM DocumentType (second SYSTEM type,
-- after RIGHT_TO_REPRESENT). Fixed UUID + ON CONFLICT (id) DO NOTHING makes this
-- idempotent: the @@unique([tenant_id, key]) index does NOT enforce for tenant_id
-- NULL (NULL != NULL in Postgres), so uniqueness rides the deterministic primary
-- key instead. Talent is the sole signer (SINGLE_SIGNATURE), evidence-only — the
-- Offer state machine remains the sole authority for ACCEPT (DOC-6 PL-1).
INSERT INTO "documents"."DocumentType"
  ("id", "tenant_id", "key", "name", "description", "scope", "execution_mode_default", "retention_class", "system_defined", "active")
VALUES
  ('d0c50006-0000-7000-8000-000000000001', NULL, 'OFFER_LETTER', 'Offer Letter',
   'Offer letter presented to a talent for signature. Execution is durable documentary evidence only; it does not advance the Offer state.',
   'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD', true, true)
ON CONFLICT ("id") DO NOTHING;
