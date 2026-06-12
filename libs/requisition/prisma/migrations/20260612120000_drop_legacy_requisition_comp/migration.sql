-- PR-A1 Requisition-Gating Rework — DROP the legacy free-text compensation
-- columns (rate_max, salary) from requisition."Requisition".
--
-- DESTRUCTIVE: this removes two columns. Authorized under the PR-A directive
-- carve-out (authz rework + destructive migration). Safe because:
--   1. The columns have been write-blocked + read-stripped since
--      D-AUTHZ-COMP-WRITE-1 — every write path ignores them and they never
--      appear in RequisitionView, so they are inert.
--   2. A zero-rows precondition was confirmed before the drop:
--        SELECT count(*) FROM requisition."Requisition"
--          WHERE rate_max IS NOT NULL OR salary IS NOT NULL;  -- = 0
--      (re-confirm against the target environment before applying in prod).
--   3. The structured successors are canonical: pay_rate_amount /
--      bill_rate_amount supersede rate_max; salary_amount / salary_currency
--      supersede salary.
ALTER TABLE "requisition"."Requisition" DROP COLUMN "rate_max";
ALTER TABLE "requisition"."Requisition" DROP COLUMN "salary";
