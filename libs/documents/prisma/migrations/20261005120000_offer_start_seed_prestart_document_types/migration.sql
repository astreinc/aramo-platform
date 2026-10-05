-- Offer & Start Journey (directive §5.3) — seed the pre-start governed SYSTEM
-- DocumentTypes the approved Offer & Start UX surfaces in its Documents rail,
-- after RIGHT_TO_REPRESENT (DOC-5) and OFFER_LETTER (DOC-6). Fixed UUIDs +
-- ON CONFLICT (id) DO NOTHING keep this idempotent: the @@unique([tenant_id,key])
-- index does NOT enforce for tenant_id NULL (NULL != NULL in Postgres), so
-- uniqueness rides the deterministic primary key instead.
--
-- All three are talent-signed (SINGLE_SIGNATURE). The "required by <client>" vs
-- "tenant standard" distinction the UX shows lives in the pre-start requirement
-- layer, NOT the document-type scope — these are reusable platform-provided types
-- exactly like OFFER_LETTER. No new document-domain concept is introduced; the
-- background-check RESULT remains separate manual evidence (Aramo performs no
-- automated check), and no work-authorization determination is inferred here.
INSERT INTO "documents"."DocumentType"
  ("id", "tenant_id", "key", "name", "description", "scope", "execution_mode_default", "retention_class", "system_defined", "active")
VALUES
  ('d0c50007-0000-7000-8000-000000000001', NULL, 'CLIENT_NDA', 'Client NDA',
   'Client confidentiality agreement presented to a talent for signature as a pre-start requirement. The requiring client/tenant is expressed by the pre-start requirement set, not by this type.',
   'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD', true, true),
  ('d0c50007-0000-7000-8000-000000000002', NULL, 'BACKGROUND_AUTHORIZATION', 'Background Authorization',
   'Talent authorization form signed before a background check proceeds. The check RESULT is captured separately as manual evidence; Aramo performs no automated check.',
   'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD', true, true),
  ('d0c50007-0000-7000-8000-000000000003', NULL, 'I9', 'I-9 (Employment Eligibility Verification)',
   'Work-authorization form completed as a pre-start requirement. Aramo infers no immigration or work-authorization determination; this is a governed document only.',
   'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD', true, true)
ON CONFLICT ("id") DO NOTHING;
