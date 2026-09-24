-- DOC-1b — reconcile TalentDocument onto the canonical documents.Document.
-- Governing directive Aramo-DOC-1b-TalentDocument-Reconciliation-Slice-Directive-v1_0-LOCKED.
-- Expand phase: seed SYSTEM DocumentTypes, ADD TalentDocument.document_id
-- (nullable, UUID-only, no cross-schema FK), and backfill each existing
-- TalentDocument into Document + DocumentRevision + DocumentArtifact +
-- DocumentAssociation(TALENT). TalentDocument.id is preserved (ADD-not-rename).
-- Cross-schema: this migration runs AFTER the documents init migration
-- (later timestamp), so the documents schema/tables exist. splitDdl-safe:
-- no semicolons inside comment lines, no dollar-quoted bodies.

-- Seed the six SYSTEM DocumentTypes (one per TalentDocumentType value).
-- Deterministic UUIDs, idempotent via ON CONFLICT on the primary key.
INSERT INTO "documents"."DocumentType"
  ("id", "tenant_id", "key", "name", "description", "scope", "execution_mode_default", "retention_class", "system_defined", "active")
VALUES
  ('01900000-0000-7000-8000-0000000002d1', NULL, 'TALENT_RESUME', 'Talent Resume', 'Talent-uploaded resume', 'SYSTEM', 'NO_SIGNATURE', 'TALENT_DOCUMENT', true, true),
  ('01900000-0000-7000-8000-0000000002d2', NULL, 'TALENT_COVER_LETTER', 'Talent Cover Letter', 'Talent-uploaded cover letter', 'SYSTEM', 'NO_SIGNATURE', 'TALENT_DOCUMENT', true, true),
  ('01900000-0000-7000-8000-0000000002d3', NULL, 'TALENT_CERTIFICATION', 'Talent Certification', 'Talent-uploaded certification', 'SYSTEM', 'NO_SIGNATURE', 'TALENT_DOCUMENT', true, true),
  ('01900000-0000-7000-8000-0000000002d4', NULL, 'TALENT_WORK_SAMPLE', 'Talent Work Sample', 'Talent-uploaded work sample', 'SYSTEM', 'NO_SIGNATURE', 'TALENT_DOCUMENT', true, true),
  ('01900000-0000-7000-8000-0000000002d5', NULL, 'TALENT_REFERENCE_LETTER', 'Talent Reference Letter', 'Talent-uploaded reference letter', 'SYSTEM', 'NO_SIGNATURE', 'TALENT_DOCUMENT', true, true),
  ('01900000-0000-7000-8000-0000000002d6', NULL, 'TALENT_OTHER', 'Talent Document', 'Talent-uploaded document (other)', 'SYSTEM', 'NO_SIGNATURE', 'TALENT_DOCUMENT', true, true)
ON CONFLICT ("id") DO NOTHING;

-- Expand: ADD the UUID-only link column (nullable, no FK).
ALTER TABLE "talent_evidence"."TalentDocument" ADD COLUMN "document_id" UUID;

-- Backfill mapping — one stable UUID quad per un-linked TalentDocument. A temp
-- table (computed once) keeps the UUIDs stable across the sequential inserts, so
-- each dependent insert sees its parent (immediate FK checks) and the artifact
-- invariant trigger sees the revision's parent document_id.
CREATE TEMP TABLE "doc1b_map" AS
SELECT
  td."id"                   AS tdid,
  gen_random_uuid()         AS docid,
  gen_random_uuid()         AS revid,
  gen_random_uuid()         AS artid,
  gen_random_uuid()         AS associd,
  td."tenant_id"            AS tenant_id,
  td."talent_id"            AS talent_id,
  td."filename"             AS filename,
  td."file_storage_ref"     AS file_storage_ref,
  td."mime_type"            AS mime_type,
  td."size_bytes"           AS size_bytes,
  td."uploaded_by_actor_id" AS uploaded_by_actor_id,
  td."uploaded_at"          AS uploaded_at,
  td."is_active"            AS is_active,
  td."document_type"::text  AS document_type
FROM "talent_evidence"."TalentDocument" td
WHERE td."document_id" IS NULL;

INSERT INTO "documents"."Document"
  ("id", "tenant_id", "document_type_id", "title", "status", "execution_mode", "source_kind", "created_by", "created_at")
SELECT
  m.docid, m.tenant_id, dt."id", m.filename,
  CASE WHEN m.is_active THEN 'EXECUTED' ELSE 'VOIDED' END,
  'NO_SIGNATURE', 'UPLOADED', m.uploaded_by_actor_id, m.uploaded_at
FROM "doc1b_map" m
JOIN "documents"."DocumentType" dt
  ON dt."key" = 'TALENT_' || upper(m.document_type) AND dt."tenant_id" IS NULL;

INSERT INTO "documents"."DocumentRevision"
  ("id", "tenant_id", "document_id", "revision_number", "mime_type", "byte_size", "content_sha256", "status", "created_by", "created_at", "frozen_at")
SELECT
  m.revid, m.tenant_id, m.docid, 1, m.mime_type, m.size_bytes, 'backfill:unknown', 'FROZEN', m.uploaded_by_actor_id, m.uploaded_at, m.uploaded_at
FROM "doc1b_map" m;

INSERT INTO "documents"."DocumentArtifact"
  ("id", "tenant_id", "revision_id", "document_id", "artifact_role", "storage_provider", "storage_locator", "mime_type", "byte_size", "sha256", "immutability_state", "retention_class", "created_at", "created_by")
SELECT
  m.artid, m.tenant_id, m.revid, m.docid, 'SOURCE_UPLOAD', 'aramo-s3', m.file_storage_ref, m.mime_type, m.size_bytes, 'backfill:unknown', 'FROZEN', 'TALENT_DOCUMENT', m.uploaded_at, m.uploaded_by_actor_id
FROM "doc1b_map" m;

INSERT INTO "documents"."DocumentAssociation"
  ("id", "tenant_id", "document_id", "resource_type", "resource_id", "relationship", "created_at", "created_by")
SELECT
  m.associd, m.tenant_id, m.docid, 'TALENT', m.talent_id, 'SUBJECT', m.uploaded_at, m.uploaded_by_actor_id
FROM "doc1b_map" m;

UPDATE "talent_evidence"."TalentDocument" td
SET "document_id" = m.docid
FROM "doc1b_map" m
WHERE td."id" = m.tdid;

DROP TABLE "doc1b_map";

-- Contract phase — drop the GENERIC columns (now sourced from documents). Runs
-- after the backfill read them. All readers (edition projection, RTBF inventory)
-- and writers (createTalentDocument, establishCreateDraftEvidence) are re-pointed.
-- The TalentDocumentType enum type is retained (still referenced by the TS
-- TalentDocumentTypeValue union and the DocumentType-id map in the repository).
ALTER TABLE "talent_evidence"."TalentDocument"
  DROP COLUMN "uploaded_by_actor_id",
  DROP COLUMN "uploaded_at",
  DROP COLUMN "document_type",
  DROP COLUMN "filename",
  DROP COLUMN "file_storage_ref",
  DROP COLUMN "mime_type",
  DROP COLUMN "size_bytes";

-- DOC-1b — deleting a Document cascades its associations. Talent-erasure deletes
-- a talent's Documents via the association subquery, so the association must not
-- block on RESTRICT. CASCADE is the correct association-to-document semantics
-- (an association to a deleted Document is meaningless). Global, not talent-only.
ALTER TABLE "documents"."DocumentAssociation" DROP CONSTRAINT "DocumentAssociation_document_id_fkey";
ALTER TABLE "documents"."DocumentAssociation" ADD CONSTRAINT "DocumentAssociation_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"."Document" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
