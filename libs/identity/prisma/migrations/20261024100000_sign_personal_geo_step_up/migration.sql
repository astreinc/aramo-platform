-- Aramo Sign Personal (Free) — Architect GeoLite2 ruling (2026-10-21) + PO
-- "review replaces phone" while SMS is on hold. Additive on the two tables
-- 20261022120000_sign_personal_free created (that migration is merged and immutable).

-- The GeoLite2 evidence behind a signup decision: { country (null = UNKNOWN),
-- looked_up_at, db_version }. A risk signal, never proof of residence.
ALTER TABLE "identity"."PersonalSignupRequest" ADD COLUMN "geo_evidence" JSONB;

-- 'review' = an operator's review lifted the phone step while SMS was
-- unavailable. It is NOT phone assurance: phone_verified_at stays NULL.
ALTER TABLE "identity"."TenantRiskState" ADD COLUMN "step_up_cleared_by" TEXT;
ALTER TABLE "identity"."TenantRiskState" ADD CONSTRAINT "TenantRiskState_step_up_cleared_by_check"
  CHECK ("step_up_cleared_by" IS NULL OR "step_up_cleared_by" IN ('review'));
