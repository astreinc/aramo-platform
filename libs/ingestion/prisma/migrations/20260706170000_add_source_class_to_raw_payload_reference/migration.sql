-- TR-2a-B1 (DDR-1 §3.1 + §4) — RawPayloadReference.source_class
-- The arrival's attestation level, server-derived from `source` via the
-- ingestion channel-source_class map, written once at ingest and never
-- caller-supplied. Add nullable, backfill existing rows by the channel map
-- (talent_direct maps to SELF, every other and unmapped source falls to the
-- fail-closed THIRD_PARTY_UNVERIFIED default per DDR-1 §4), then enforce NOT
-- NULL so the pattern is safe on an already-populated table.
ALTER TABLE "ingestion"."RawPayloadReference" ADD COLUMN "source_class" TEXT;

UPDATE "ingestion"."RawPayloadReference"
SET "source_class" = CASE
  WHEN "source" = 'talent_direct' THEN 'SELF'
  ELSE 'THIRD_PARTY_UNVERIFIED'
END
WHERE "source_class" IS NULL;

ALTER TABLE "ingestion"."RawPayloadReference" ALTER COLUMN "source_class" SET NOT NULL;
