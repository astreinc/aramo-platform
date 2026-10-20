-- Aramo Sign Unified Product directive (Aramo-Sign-Unified-Product-Permission-
-- Contract-Platform-API-Directive-v1_0-LOCKED) S-1 — envelope provenance.
-- Every envelope records its owner (created_by, unchanged), the application it
-- came from, the installation that created it (S-4, nullable until then) and the
-- kind of acting principal. Additive only, no rename (ADD-not-rename).
-- splitDdl-safe: no semicolons inside comment lines.

ALTER TABLE "esign"."SignatureEnvelope"
  ADD COLUMN "source_application" TEXT NOT NULL DEFAULT 'aramo-sign',
  ADD COLUMN "installation_id" UUID,
  ADD COLUMN "origin_actor_kind" TEXT NOT NULL DEFAULT 'USER';

ALTER TABLE "esign"."SignatureEnvelope"
  ADD CONSTRAINT "SignatureEnvelope_source_application_check"
  CHECK ("source_application" ~ '^[a-z][a-z0-9-]{1,62}$');

ALTER TABLE "esign"."SignatureEnvelope"
  ADD CONSTRAINT "SignatureEnvelope_origin_actor_kind_check"
  CHECK ("origin_actor_kind" IN ('USER', 'APPLICATION'));

-- Backfill: envelopes sourced from Core Documents were created by the ATS.
UPDATE "esign"."SignatureEnvelope" e
   SET "source_application" = 'aramo-ats'
 WHERE EXISTS (
   SELECT 1 FROM "esign"."EnvelopeDocument" d
    WHERE d."envelope_id" = e."id" AND d."source_mode" = 'CORE_REF'
 );

CREATE INDEX "SignatureEnvelope_tenant_id_created_by_idx" ON "esign"."SignatureEnvelope"("tenant_id", "created_by");
