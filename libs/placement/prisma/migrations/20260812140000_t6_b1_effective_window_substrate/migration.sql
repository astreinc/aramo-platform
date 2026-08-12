-- Track 6 / T6-B1 -- Effective-Window Substrate. Converts T5's deliberately open
-- AssignmentRateVersion into a governed interval model: explicit half-open windows,
-- DB-enforced non-overlap, one narrowly authorized first-close capability, and the
-- same-row cancellation state future lifecycle (B3) needs. This migration strengthens
-- constraints and establishes the invariants for FUTURE data -- it performs NO
-- backfill, reconciliation, or historical-row mutation. Per the T6-B1 zero-data
-- amendment the PO has confirmed production holds ZERO AssignmentRateVersion rows, so
-- no production reconciliation preflight is required (if production is found populated
-- before deploy, HALT to Architect/PO). Deploys under the normal migrate-before-app order.
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments (submittal / T5 precedent).

-- 1. Cancellation representation (directive section 3). Nullable and written by NO
-- B1 application code -- they stay NULL for every existing and B1-created row. The
-- B3 cancellation operation owns their governed write. cancellation_reason_code is
-- a nullable TEXT code (NOT a premature Postgres enum -- B3 rules the vocabulary).
ALTER TABLE "placement"."AssignmentRateVersion"
  ADD COLUMN "cancelled_at" TIMESTAMPTZ(6),
  ADD COLUMN "cancelled_by" UUID,
  ADD COLUMN "cancellation_reason_code" TEXT;

-- 2. Interval validity (directive section 6). Applies at rest to every row. An open
-- window (NULL effective_to) is valid -- a closed window must be strictly forward.
ALTER TABLE "placement"."AssignmentRateVersion"
  ADD CONSTRAINT "AssignmentRateVersion_interval_valid_chk"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");

-- 3. Overlap prevention (directive section 7). Aramo's first GiST range exclusion.
-- btree_gist is installed WITH SCHEMA public and the scalar opclasses are
-- schema-qualified (public.gist_uuid_ops) so the index builds regardless of the
-- per-schema connection search_path Prisma sets for the placement datasource --
-- mirroring the pg_trgm precedent. tstzrange range_ops and the overlap operator
-- live in pg_catalog (always on path). CREATE EXTENSION IF NOT EXISTS is idempotent.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

-- For non-cancelled rows, two effective windows must never overlap for the same
-- (tenant_id, contract_assignment_id). NULL effective_to is modelled as +infinity so
-- an open window reserves everything from effective_from onward. Half-open [) means
-- adjacent windows sharing an instant do NOT overlap. A version cancelled under B3
-- (cancelled_at IS NOT NULL) drops out of the predicate and no longer reserves its
-- former window -- the reason the flag must live on this same table.
ALTER TABLE "placement"."AssignmentRateVersion"
  ADD CONSTRAINT "AssignmentRateVersion_no_window_overlap_excl"
  EXCLUDE USING gist (
    "tenant_id" public.gist_uuid_ops WITH =,
    "contract_assignment_id" public.gist_uuid_ops WITH =,
    tstzrange("effective_from", COALESCE("effective_to", 'infinity'), '[)') WITH &&
  )
  WHERE ("cancelled_at" IS NULL);

-- 4. Governed effective_to first-close (directive section 4). CREATE OR REPLACE the
-- rate-version mutation trigger function, PRESERVING the tenant-reset DELETE escape
-- byte-for-byte, and ADDING one narrowly governed UPDATE branch. Under the exact
-- transaction-local marker app.assignment_commercial_revision = 'authorized', the
-- ONLY permitted UPDATE is effective_to NULL -> non-NULL with NEW.effective_to
-- strictly after effective_from and EVERY other column byte-identical (equality for
-- NOT NULL, IS NOT DISTINCT FROM for nullable). Reopen, re-close, no-op, any other
-- column change, missing/wrong marker -- all fall through to the unconditional
-- reject. Nullable comparisons never use bare equality (the NULL = NULL trap).
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

  -- TG_OP = 'UPDATE' from here. The sole sanctioned mutation is the governed
  -- effective_to first-close under the exact-value revision marker.
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

  RAISE EXCEPTION 'placement.AssignmentRateVersion is append-only -- the only permitted UPDATE is the governed effective_to first-close under app.assignment_commercial_revision -- reopen, re-close, no-op, and any other column change are rejected'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
