-- TALENT-INTEL-1 TI-1G section-2 temporal/current-state semantics.
-- ADDITIVE only (ADD-not-rename): four nullable-or-defaulted columns on the
-- append-only TalentWorkAuthorization entity. No column is renamed, dropped, or
-- reinterpreted, so no existing work-auth data is destroyed or re-meant.
-- asserted_at defaults to now() (the assertion time is always known, never
-- invented) and backfills the dormant table. effective_from/effective_to/
-- expires_at stay NULL until a surface explicitly supplies them (no fake precision).
ALTER TABLE "talent_evidence"."TalentWorkAuthorization"
  ADD COLUMN "asserted_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN "effective_from" DATE,
  ADD COLUMN "effective_to" DATE,
  ADD COLUMN "expires_at" DATE;
