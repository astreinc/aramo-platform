-- TR-2a-B1 (DDR-1 §3.2) — SubjectAnchor.source_class
-- The anchor row denormalizes the SourceClass of its minting EvidenceRecord so
-- the matcher reads attestation strength without a join. Add nullable, backfill
-- from the source EvidenceRecord via source_evidence_id (the projection is
-- atomic-with-evidence going forward inside insertAnchor), then enforce NOT NULL
-- so the pattern is safe on an already-populated table.
ALTER TABLE "talent_trust"."SubjectAnchor" ADD COLUMN "source_class" TEXT;

UPDATE "talent_trust"."SubjectAnchor" a
SET "source_class" = e."source_class"
FROM "talent_trust"."EvidenceRecord" e
WHERE a."source_evidence_id" = e."id" AND a."source_class" IS NULL;

ALTER TABLE "talent_trust"."SubjectAnchor" ALTER COLUMN "source_class" SET NOT NULL;
