-- SRC-2 PR-2 (R3) — the publish surface on requisition.Requisition.
-- Additive ONLY — five new nullable/defaulted columns. No backfill, no drops,
-- no index churn. UNGATED authored public statements (NOT derived from / defaulted
-- from / validated against the gated pay_rate_* / salary_* / financials fields).
--
--   public_listing          Boolean  -- default false; the recruiter's publication intent
--   advertised_pay_min      Decimal? -- the comp the recruiter chooses to advertise
--   advertised_pay_max      Decimal? --   (distinct from the gated pay_rate_*/salary_* actuals)
--   advertised_pay_period   RatePeriod? -- reuses the existing period enum
--   advertised_pay_currency String?

ALTER TABLE "requisition"."Requisition"
  ADD COLUMN "public_listing" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "advertised_pay_min" DECIMAL(12,2),
  ADD COLUMN "advertised_pay_max" DECIMAL(12,2),
  ADD COLUMN "advertised_pay_period" "requisition"."RatePeriod",
  ADD COLUMN "advertised_pay_currency" TEXT;
