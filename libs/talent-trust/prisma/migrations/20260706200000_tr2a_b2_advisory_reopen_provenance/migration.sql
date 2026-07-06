-- TR-2a-B2 (DDR-2 §5) — SubjectMatchAdvisory re-open provenance
-- A DISMISSED advisory re-opens to PENDING_REVIEW only on strictly-stronger
-- evidence (shared-ref count up OR a new confirmed_kinds entry) and these columns
-- record that it is a re-open, not a fresh pair. Nullable. No backfill.
ALTER TABLE "talent_trust"."SubjectMatchAdvisory" ADD COLUMN "reopened_at" TIMESTAMPTZ;

ALTER TABLE "talent_trust"."SubjectMatchAdvisory" ADD COLUMN "reopened_from_band" TEXT;
