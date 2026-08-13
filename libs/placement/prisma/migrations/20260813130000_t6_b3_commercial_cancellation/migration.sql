-- Track 6 / T6-B3 -- Future revision cancellation + assignment-END commercial
-- reconciliation. Adds the durable assignment-end instant and extends the
-- AssignmentRateVersion mutation trigger with two NEW governed branches under a
-- NEW transaction-local capability, while preserving the T6-B1 first-close branch
-- and the tenant-reset DELETE escape byte-for-byte. No column is added to
-- AssignmentRateVersion (the cancellation columns already exist from B1). The
-- non-partial (tenant_id, contract_assignment_id, effective_from) unique key is
-- NOT altered (a cancelled row keeps reserving its exact instant -- directive §5).
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments (submittal / T5 / B1 precedent).

-- 1. Durable assignment-end instant (directive §15). ONE server T_end is stored
-- here and reused for commercial-window reconciliation and the assignment-ended
-- event -- no independent clocks. Nullable: an ACTIVE assignment has none, and old
-- rows / the pre-B3 app never set it (backward-compatible additive column).
ALTER TABLE "placement"."ContractAssignment"
  ADD COLUMN "ended_at" TIMESTAMPTZ(6);

-- 2. Extend the ARV mutation trigger (directive §7, §8). CREATE OR REPLACE the
-- function -- the trigger binding is unchanged. THREE sanctioned UPDATE branches
-- now exist, each with a mutually-exclusive predicate:
--   B1 first-close   -- under app.assignment_commercial_revision
--   B3 cancellation  -- under app.assignment_commercial_cancellation (write-once)
--   B3 re-open       -- under app.assignment_commercial_cancellation (future-only)
-- The DELETE tenant-reset escape and the unconditional fall-through reject are
-- preserved. Nullable comparisons use IS NOT DISTINCT FROM (no NULL=NULL trap).
CREATE OR REPLACE FUNCTION placement.reject_assignment_rate_version_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.tenant_reset', true) = 'authorized' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'placement.AssignmentRateVersion is append-only -- DELETE is not permitted'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Branch 1 (T6-B1) -- governed effective_to FIRST-CLOSE under the revision marker.
  IF current_setting('app.assignment_commercial_revision', true) = 'authorized'
     AND OLD."effective_to" IS NULL
     AND NEW."effective_to" IS NOT NULL
     AND NEW."effective_to" > OLD."effective_from"
     AND OLD."id" = NEW."id"
     AND OLD."tenant_id" = NEW."tenant_id"
     AND OLD."contract_assignment_id" = NEW."contract_assignment_id"
     AND OLD."requisition_id" = NEW."requisition_id"
     AND OLD."talent_record_id" = NEW."talent_record_id"
     AND OLD."pay_rate_amount" = NEW."pay_rate_amount"
     AND OLD."bill_rate_amount" = NEW."bill_rate_amount"
     AND OLD."currency" = NEW."currency"
     AND OLD."rate_period" = NEW."rate_period"
     AND OLD."effective_from" = NEW."effective_from"
     AND OLD."recorded_by" = NEW."recorded_by"
     AND OLD."created_at" = NEW."created_at"
     AND OLD."change_reason" IS NOT DISTINCT FROM NEW."change_reason"
     AND OLD."cancelled_at" IS NOT DISTINCT FROM NEW."cancelled_at"
     AND OLD."cancelled_by" IS NOT DISTINCT FROM NEW."cancelled_by"
     AND OLD."cancellation_reason_code" IS NOT DISTINCT FROM NEW."cancellation_reason_code"
  THEN
    RETURN NEW;
  END IF;

  -- Branch 2 (T6-B3) -- governed write-once CANCELLATION under the cancellation
  -- marker. All THREE cancellation fields go NULL -> non-NULL together, and every
  -- commercial and interval column (incl. effective_to) stays byte-identical.
  IF current_setting('app.assignment_commercial_cancellation', true) = 'authorized'
     AND OLD."cancelled_at" IS NULL              AND NEW."cancelled_at" IS NOT NULL
     AND OLD."cancelled_by" IS NULL              AND NEW."cancelled_by" IS NOT NULL
     AND OLD."cancellation_reason_code" IS NULL  AND NEW."cancellation_reason_code" IS NOT NULL
     AND OLD."id" = NEW."id"
     AND OLD."tenant_id" = NEW."tenant_id"
     AND OLD."contract_assignment_id" = NEW."contract_assignment_id"
     AND OLD."requisition_id" = NEW."requisition_id"
     AND OLD."talent_record_id" = NEW."talent_record_id"
     AND OLD."pay_rate_amount" = NEW."pay_rate_amount"
     AND OLD."bill_rate_amount" = NEW."bill_rate_amount"
     AND OLD."currency" = NEW."currency"
     AND OLD."rate_period" = NEW."rate_period"
     AND OLD."effective_from" = NEW."effective_from"
     AND OLD."effective_to" IS NOT DISTINCT FROM NEW."effective_to"
     AND OLD."recorded_by" = NEW."recorded_by"
     AND OLD."created_at" = NEW."created_at"
     AND OLD."change_reason" IS NOT DISTINCT FROM NEW."change_reason"
  THEN
    RETURN NEW;
  END IF;

  -- Branch 3 (T6-B3) -- governed future-boundary RE-OPEN under the cancellation
  -- marker. Withdraws a NOT-YET-EFFECTIVE scheduled closure: bounded effective_to
  -- -> NULL, ONLY when the old boundary is still in the future by transaction-stable
  -- database time. Never re-opens an effective/historical boundary, never touches a
  -- cancelled row, and leaves every other column unchanged.
  IF current_setting('app.assignment_commercial_cancellation', true) = 'authorized'
     AND OLD."effective_to" IS NOT NULL
     AND NEW."effective_to" IS NULL
     AND OLD."effective_to" > now()
     AND OLD."cancelled_at" IS NULL
     AND OLD."id" = NEW."id"
     AND OLD."tenant_id" = NEW."tenant_id"
     AND OLD."contract_assignment_id" = NEW."contract_assignment_id"
     AND OLD."requisition_id" = NEW."requisition_id"
     AND OLD."talent_record_id" = NEW."talent_record_id"
     AND OLD."pay_rate_amount" = NEW."pay_rate_amount"
     AND OLD."bill_rate_amount" = NEW."bill_rate_amount"
     AND OLD."currency" = NEW."currency"
     AND OLD."rate_period" = NEW."rate_period"
     AND OLD."effective_from" = NEW."effective_from"
     AND OLD."recorded_by" = NEW."recorded_by"
     AND OLD."created_at" = NEW."created_at"
     AND OLD."change_reason" IS NOT DISTINCT FROM NEW."change_reason"
     AND OLD."cancelled_at" IS NOT DISTINCT FROM NEW."cancelled_at"
     AND OLD."cancelled_by" IS NOT DISTINCT FROM NEW."cancelled_by"
     AND OLD."cancellation_reason_code" IS NOT DISTINCT FROM NEW."cancellation_reason_code"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'placement.AssignmentRateVersion is append-only -- the only permitted UPDATEs are the governed effective_to first-close (app.assignment_commercial_revision), the write-once cancellation, and the future-boundary re-open (app.assignment_commercial_cancellation) -- reopen of an effective boundary, re-close, no-op, partial cancellation, and any other column change are rejected'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
