-- Company-Fields — add the off-limits (do-not-source) flag. UN-GATED operational
-- boolean, defaulted false so existing rows are NOT off-limits. Distinct from
-- `exclusivity` (a supplier-relationship term).
ALTER TABLE "company"."Company"
  ADD COLUMN "off_limits" BOOLEAN NOT NULL DEFAULT false;
