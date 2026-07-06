-- TR-2a-B2 (Name-Wiring ruling §1) — RawPayloadReference.declared_name
-- The channel-supplied structured declared name, a CLAIM (caller-suppliable by
-- nature, distinct from server-derived source_class) consumed only by the
-- CONFIRMED-arm NAME guard. Nullable — today's channels supply none, so the
-- guard passes vacuously by the absence rule. No backfill.
ALTER TABLE "ingestion"."RawPayloadReference" ADD COLUMN "declared_name" TEXT;
