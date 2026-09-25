-- DOC-5 (R-5-2) — seed the RIGHT_TO_REPRESENT SYSTEM DocumentType (first SYSTEM
-- type). Fixed UUID + ON CONFLICT (id) DO NOTHING makes this idempotent: the
-- @@unique([tenant_id, key]) index does NOT enforce for tenant_id NULL (NULL !=
-- NULL in Postgres), so uniqueness rides the deterministic primary key instead.
INSERT INTO "documents"."DocumentType"
  ("id", "tenant_id", "key", "name", "description", "scope", "execution_mode_default", "retention_class", "system_defined", "active")
VALUES
  ('d0c50005-0000-7000-8000-000000000001', NULL, 'RIGHT_TO_REPRESENT', 'Right to Represent',
   'Talent authorization for a recruiter/agency to represent them to a specific client/requisition.',
   'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD', true, true)
ON CONFLICT ("id") DO NOTHING;
