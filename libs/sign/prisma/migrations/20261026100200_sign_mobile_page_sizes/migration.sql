-- Aramo Sign Mobile — page sizes of a source document (W7, D-W6-2).
-- Governing: Aramo-Sign-Mobile-Native-Application-Implementation-Directive-v1_0-LOCKED
-- §5 (field geometry in PDF points, bottom-left origin, identical to the web editor).
-- Additive only: one new table. The sender detail reports documents[].pages
-- ({width, height} per page, each page's MediaBox in points, 0-based by position),
-- computed from the frozen source bytes at upload and, for documents uploaded
-- before this table existed, on first read.
--
-- A side table rather than a column on EnvelopeDocument: every write to an
-- EnvelopeDocument row raises the envelope revision (migration 20261026100100,
-- M-A3 §6), so filling a cache on a read must not touch that row. This table has
-- no revision trigger; its rows are derived from immutable source bytes and are
-- removed with their document.
CREATE TABLE "sign"."SignEnvelopeDocumentPages" (
    "envelope_document_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "pages" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignEnvelopeDocumentPages_pkey" PRIMARY KEY ("envelope_document_id"),
    CONSTRAINT "SignEnvelopeDocumentPages_pages_check" CHECK (jsonb_typeof("pages") = 'array' AND jsonb_array_length("pages") >= 1)
);
CREATE INDEX "SignEnvelopeDocumentPages_tenant_id_idx" ON "sign"."SignEnvelopeDocumentPages"("tenant_id");
ALTER TABLE "sign"."SignEnvelopeDocumentPages" ADD CONSTRAINT "SignEnvelopeDocumentPages_envelope_document_id_fkey"
  FOREIGN KEY ("envelope_document_id") REFERENCES "sign"."EnvelopeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
