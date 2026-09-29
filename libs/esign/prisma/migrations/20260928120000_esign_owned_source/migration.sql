-- E-Sign Product Experience V1 · Foundation F1 (D-1) — E-Sign-owned source docs.
-- Adds a source-addressing MODE to EnvelopeDocument so E-Sign can own an uploaded
-- PDF directly (OWNED, bytes in E-Sign object storage) instead of only referencing
-- a frozen Core Documents revision (CORE_REF). This unblocks the standalone
-- (non-ATS) subscriber path: a party with no Core Documents can attach a PDF that
-- E-Sign owns end to end. Independent-Digital-Signature-Platform Directive §16
-- (E-Sign owns its own signing-domain persistence). Additive only.
--   source_mode        OWNED  = bytes in E-Sign object storage (source_object_key)
--                      CORE_REF = frozen Documents revision pulled over HTTP (legacy ATS path)
--   source_object_key  object-storage key of the frozen OWNED source PDF (NULL for CORE_REF)
--   content_type       stored MIME of the OWNED upload (NULL for CORE_REF)
--   byte_size          stored byte length of the OWNED upload (NULL for CORE_REF)
-- Existing rows default to CORE_REF, preserving the ATS path byte-for-byte.
ALTER TABLE "esign"."EnvelopeDocument"
  ADD COLUMN "source_mode" TEXT NOT NULL DEFAULT 'CORE_REF',
  ADD COLUMN "source_object_key" TEXT,
  ADD COLUMN "content_type" TEXT,
  ADD COLUMN "byte_size" INTEGER;

-- The Documents revision refs are meaningful only for CORE_REF; OWNED docs carry
-- no Core Documents linkage, so both become nullable.
ALTER TABLE "esign"."EnvelopeDocument"
  ALTER COLUMN "document_ref" DROP NOT NULL,
  ALTER COLUMN "document_revision_ref" DROP NOT NULL;

-- Only the two known modes are allowed.
ALTER TABLE "esign"."EnvelopeDocument"
  ADD CONSTRAINT "EnvelopeDocument_source_mode_check"
  CHECK ("source_mode" IN ('OWNED', 'CORE_REF'));

-- Shape integrity: CORE_REF must carry both revision refs; OWNED must carry an
-- object key. Fail-closed at the storage boundary rather than trusting callers.
ALTER TABLE "esign"."EnvelopeDocument"
  ADD CONSTRAINT "EnvelopeDocument_source_shape_check"
  CHECK (
    ("source_mode" = 'CORE_REF' AND "document_ref" IS NOT NULL AND "document_revision_ref" IS NOT NULL)
    OR
    ("source_mode" = 'OWNED' AND "source_object_key" IS NOT NULL)
  );
