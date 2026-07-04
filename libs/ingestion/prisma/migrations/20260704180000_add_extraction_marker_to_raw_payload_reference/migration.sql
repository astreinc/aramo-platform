-- Cold-Ingest Extraction — the async subject-poll's extract-once gate + retry
-- bound on RawPayloadReference. extraction_done_at is the analogue of
-- resolved_subject_id's canonicalize-poll gate: NULL = the resolved arrival's
-- résumé still needs extraction; stamped once identity evidence is written OR
-- the résumé parses with no name (permanent — a name-less résumé must not
-- loop). extraction_attempts bounds transient (S3/fetch) retries.
--
-- Additive-only. No existing column mutated.

-- AlterTable
ALTER TABLE "ingestion"."RawPayloadReference"
    ADD COLUMN "extraction_done_at" TIMESTAMPTZ,
    ADD COLUMN "extraction_attempts" INTEGER NOT NULL DEFAULT 0;
