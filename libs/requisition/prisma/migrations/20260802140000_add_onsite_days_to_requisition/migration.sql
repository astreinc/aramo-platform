-- PR-17 (Track C) — hybrid onsite frequency. onsite_days_per_week is meaningful
-- only when work_arrangement = 'hybrid'; valid 1-4 inclusive (0 = remote and
-- 5 = onsite are work_arrangement values, not frequencies). Nullable by design:
-- a hybrid requisition whose frequency is genuinely unknown must stay
-- expressible. No default, no back-fill — existing hybrid rows stay null until
-- edited. The null-unless-hybrid and 1-4 invariants are enforced server-side at
-- the RequisitionRepository floor, never by the form.
ALTER TABLE "requisition"."Requisition" ADD COLUMN "onsite_days_per_week" INTEGER;
