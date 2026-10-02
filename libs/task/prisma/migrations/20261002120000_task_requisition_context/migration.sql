-- CRM-6 (ARAMO-TALENT-CRM-V1 §10, PO ruling) — additive only. Core untouched.
--
-- Adds an OPTIONAL contextual requisition association to Task. This is NOT
-- ownership: the task stays owned by owner_type/owner_id (a Talent, for a
-- follow-up). requisition_id only records which requisition the task is about,
-- so an explicitly-chosen follow-up ("about REQ-1001") is preserved rather than
-- reconstructed from pipelines. Cross-schema UUID-only logical ref (NO FK,
-- per the schema-per-module boundary). Nullable — all existing rows and every
-- non-contextual task stay valid. Validated at the app layer (same-tenant,
-- requisition visible, Talent-Requisition pipeline relationship).

-- AlterTable — the single nullable contextual column.
ALTER TABLE "task"."Task" ADD COLUMN "requisition_id" UUID;
