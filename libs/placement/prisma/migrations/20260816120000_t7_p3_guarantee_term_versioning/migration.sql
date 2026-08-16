-- Track 7 / T7-P3 — Guarantee-Term Versioning + Provenance (additive migration).
-- Governed by Aramo-T7-P3-Guarantee-Term-Versioning-Provenance-Implementation-Directive-v1_0-LOCKED.
--
-- Adds the reusable, placement-owned, effective-dated source of permanent-placement
-- guarantee terms keyed by (tenant_id, requisition_id) (directive section 3.1/4), plus
-- the nullable immutable guarantee-terms provenance snapshot fields on PermanentPlacement
-- (section 7). Effective windows are CALENDAR DATE, half-open [effective_from, effective_to)
-- (section 3.2). Overlap for a (tenant, requisition) is forbidden by a btree_gist daterange
-- EXCLUDE (section 5). Version rows are append-only business history (section 3.8): the ONLY
-- governed mutation is effective_to NULL to date once (revision first-close, section 6). Normal
-- DELETE is forbidden except the exact app.tenant_reset escape. No cancellation columns
-- (section 3.5 defers future-version cancellation). No backfill, no destructive change.

-- CreateTable -- the reusable effective-dated guarantee-term version (section 4). Money is
-- Decimal(12,2), never float. currency + source_type are validated at the write boundary and
-- pinned by DB CHECKs. Cross-schema requisition_id is a plain UUID axis, no FK, no join.
CREATE TABLE "placement"."PermanentPlacementGuaranteeTermVersion" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "guarantee_duration_days" INTEGER NOT NULL,
    "remedy_policy" "placement"."RemedyPolicy" NOT NULL,
    "guarantee_exposure_amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_reference" TEXT,
    "source_version" TEXT,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "supersedes_version_id" UUID,
    "correlation_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermanentPlacementGuaranteeTermVersion_pkey" PRIMARY KEY ("id")
);

-- Payload/window invariants (section 4). duration positive, exposure non-negative, half-open
-- interval strictly forward when closed, source_type from the closed code-owned registry
-- (MANUAL/IMPORTED, section 3.6 -- no premature CLIENT_CONTRACT/RATE_CARD).
ALTER TABLE "placement"."PermanentPlacementGuaranteeTermVersion"
    ADD CONSTRAINT "ppgtv_duration_positive" CHECK ("guarantee_duration_days" > 0);
ALTER TABLE "placement"."PermanentPlacementGuaranteeTermVersion"
    ADD CONSTRAINT "ppgtv_exposure_nonneg" CHECK ("guarantee_exposure_amount" >= 0);
ALTER TABLE "placement"."PermanentPlacementGuaranteeTermVersion"
    ADD CONSTRAINT "ppgtv_interval_valid" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");
ALTER TABLE "placement"."PermanentPlacementGuaranteeTermVersion"
    ADD CONSTRAINT "ppgtv_source_type_registry" CHECK ("source_type" IN ('MANUAL', 'IMPORTED'));

-- Idempotency/replay floor keyed on the effective date (section 4).
CREATE UNIQUE INDEX "ppgtv_tenant_req_from_key"
    ON "placement"."PermanentPlacementGuaranteeTermVersion" ("tenant_id", "requisition_id", "effective_from");
CREATE INDEX "ppgtv_tenant_req_idx"
    ON "placement"."PermanentPlacementGuaranteeTermVersion" ("tenant_id", "requisition_id");

-- Overlap exclusion (section 5). btree_gist supplies the scalar equality opclass for the two
-- UUID axes (schema-qualified public.gist_uuid_ops so it resolves under the per-schema
-- search_path). daterange with a NULL upper bound is unbounded-above -- the open current tail.
-- Half-open [) means adjacent windows sharing an instant do NOT overlap. Idempotent create.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

ALTER TABLE "placement"."PermanentPlacementGuaranteeTermVersion"
    ADD CONSTRAINT "ppgtv_no_window_overlap_excl"
    EXCLUDE USING gist (
        "tenant_id" public.gist_uuid_ops WITH =,
        "requisition_id" public.gist_uuid_ops WITH =,
        daterange("effective_from", "effective_to", '[)') WITH &&
    );

-- Append-only + governed first-close trigger (section 6). DELETE forbidden except the exact
-- app.tenant_reset escape (the AssignmentRateVersion / PermanentPlacementRemedy precedent).
-- The ONLY sanctioned UPDATE is the effective_to first-close (NULL to date, once) under the
-- exact-value app.guarantee_terms_revision marker, with every other column pinned byte-identical
-- (bare = for NOT NULL columns, NULL-safe IS NOT DISTINCT FROM for nullable ones -- never the
-- NULL=NULL trap). Any other UPDATE (reopen, re-close, payload/provenance change, missing/wrong
-- marker) falls through to an unconditional immutability reject.
CREATE OR REPLACE FUNCTION placement.enforce_ppgtv_append_only()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.tenant_reset', true) = 'authorized' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'placement.PermanentPlacementGuaranteeTermVersion is append-only -- DELETE is not permitted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF current_setting('app.guarantee_terms_revision', true) = 'authorized'
     AND OLD."effective_to" IS NULL
     AND NEW."effective_to" IS NOT NULL
     AND NEW."effective_to" > OLD."effective_from"
     AND OLD."id" = NEW."id"
     AND OLD."tenant_id" = NEW."tenant_id"
     AND OLD."requisition_id" = NEW."requisition_id"
     AND OLD."effective_from" = NEW."effective_from"
     AND OLD."guarantee_duration_days" = NEW."guarantee_duration_days"
     AND OLD."remedy_policy" = NEW."remedy_policy"
     AND OLD."guarantee_exposure_amount" = NEW."guarantee_exposure_amount"
     AND OLD."currency" = NEW."currency"
     AND OLD."source_type" = NEW."source_type"
     AND OLD."source_reference" IS NOT DISTINCT FROM NEW."source_reference"
     AND OLD."source_version" IS NOT DISTINCT FROM NEW."source_version"
     AND OLD."recorded_by" = NEW."recorded_by"
     AND OLD."recorded_at" = NEW."recorded_at"
     AND OLD."supersedes_version_id" IS NOT DISTINCT FROM NEW."supersedes_version_id"
     AND OLD."correlation_id" IS NOT DISTINCT FROM NEW."correlation_id"
     AND OLD."created_at" = NEW."created_at"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'placement.PermanentPlacementGuaranteeTermVersion payload/provenance is immutable -- only a governed effective_to first-close is permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_ppgtv_append_only
  BEFORE UPDATE OR DELETE ON "placement"."PermanentPlacementGuaranteeTermVersion"
  FOR EACH ROW EXECUTE FUNCTION placement.enforce_ppgtv_append_only();

-- AlterTable -- the nullable immutable guarantee-terms provenance snapshot on PermanentPlacement
-- (section 7). NULL for every P1/P2 row and never backfilled. When a resolved term version is
-- applied at activation these are COPIED once (with the existing guarantee_* payload columns) and
-- then frozen by the snapshot trigger below. guarantee_term_version_id is a plain intra-schema
-- UUID lineage pointer (no FK).
ALTER TABLE "placement"."PermanentPlacement"
    ADD COLUMN "guarantee_term_version_id" UUID,
    ADD COLUMN "guarantee_terms_source_type" TEXT,
    ADD COLUMN "guarantee_terms_source_reference" TEXT,
    ADD COLUMN "guarantee_terms_source_version" TEXT;

-- Provenance coherence (section 7). source_type from the closed registry when present, and the
-- version-id + source_type travel together (both copied at activation, or both absent for a
-- legacy row). source_reference/source_version stay independently optional.
ALTER TABLE "placement"."PermanentPlacement"
    ADD CONSTRAINT "pp_guarantee_terms_source_type_registry"
    CHECK ("guarantee_terms_source_type" IS NULL OR "guarantee_terms_source_type" IN ('MANUAL', 'IMPORTED'));
ALTER TABLE "placement"."PermanentPlacement"
    ADD CONSTRAINT "pp_guarantee_terms_provenance_pair"
    CHECK (("guarantee_term_version_id" IS NULL) = ("guarantee_terms_source_type" IS NULL));

-- Reconcile the snapshot-immutability trigger (section 7): the guarantee snapshot stays frozen --
-- lifecycle_state may still change, the four falloff columns stay NULL-safe WRITE-ONCE -- and the
-- four T7-P3 provenance fields are pinned NULL-safely (IS DISTINCT FROM, never a bare OLD=NEW).
-- They are populated at activation INSERT (copy-at-activation) and NEVER change afterward, so an
-- unconditional NULL-safe pin is correct (a legacy NULL row stays NULL: NULL IS DISTINCT FROM NULL
-- is false). Preserves the T7-P2 pin set byte-for-byte and only adds the four provenance pins.
CREATE OR REPLACE FUNCTION placement.enforce_permanent_placement_snapshot_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW."id" IS DISTINCT FROM OLD."id")
     OR (NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id")
     OR (NEW."placement_process_id" IS DISTINCT FROM OLD."placement_process_id")
     OR (NEW."submittal_id" IS DISTINCT FROM OLD."submittal_id")
     OR (NEW."requisition_id" IS DISTINCT FROM OLD."requisition_id")
     OR (NEW."talent_record_id" IS DISTINCT FROM OLD."talent_record_id")
     OR (NEW."guarantee_start_date" IS DISTINCT FROM OLD."guarantee_start_date")
     OR (NEW."guarantee_duration_days" IS DISTINCT FROM OLD."guarantee_duration_days")
     OR (NEW."guarantee_end_date" IS DISTINCT FROM OLD."guarantee_end_date")
     OR (NEW."remedy_policy" IS DISTINCT FROM OLD."remedy_policy")
     OR (NEW."guarantee_exposure_amount" IS DISTINCT FROM OLD."guarantee_exposure_amount")
     OR (NEW."guarantee_exposure_currency" IS DISTINCT FROM OLD."guarantee_exposure_currency")
     OR (NEW."terms_source" IS DISTINCT FROM OLD."terms_source")
     OR (NEW."recorded_by" IS DISTINCT FROM OLD."recorded_by")
     OR (NEW."created_at" IS DISTINCT FROM OLD."created_at")
     OR (OLD."falloff_effective_date" IS NOT NULL AND NEW."falloff_effective_date" IS DISTINCT FROM OLD."falloff_effective_date")
     OR (OLD."falloff_reason" IS NOT NULL AND NEW."falloff_reason" IS DISTINCT FROM OLD."falloff_reason")
     OR (OLD."falloff_recorded_by" IS NOT NULL AND NEW."falloff_recorded_by" IS DISTINCT FROM OLD."falloff_recorded_by")
     OR (OLD."falloff_recorded_at" IS NOT NULL AND NEW."falloff_recorded_at" IS DISTINCT FROM OLD."falloff_recorded_at")
     OR (NEW."guarantee_term_version_id" IS DISTINCT FROM OLD."guarantee_term_version_id")
     OR (NEW."guarantee_terms_source_type" IS DISTINCT FROM OLD."guarantee_terms_source_type")
     OR (NEW."guarantee_terms_source_reference" IS DISTINCT FROM OLD."guarantee_terms_source_reference")
     OR (NEW."guarantee_terms_source_version" IS DISTINCT FROM OLD."guarantee_terms_source_version")
  THEN
    RAISE EXCEPTION
      'PermanentPlacement guarantee snapshot is immutable (T7 section 7) -- only lifecycle_state and the write-once falloff facts may change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
