-- SKILL-TAX-1E — CanonicalMatchShadowObservation append-only DARK telemetry.
-- Records the parallel CANONICAL view of the critical-skill match so canonical-vs
-- -name divergence can be observed WITHOUT changing the authoritative matcher.
-- Written only when SKILL_CANONICAL_SHADOW_ENABLED is on. match_class is governed
-- vocab (String col + DB CHECK, directive closed-vocab rule) over the PO-accepted
-- 7-class v1 taxonomy. No FK (UUID-only refs). Absolute-immutability trigger makes
-- the table append-only (rejects every UPDATE unconditionally, mirroring
-- ExaminationOverride, NOT a column-scoped OLD=NEW trigger, so the nullable columns
-- are safe from the NULL=NULL first-row-rejection hazard).

-- CreateTable
CREATE TABLE "examination"."CanonicalMatchShadowObservation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "examination_id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "golden_profile_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "match_class" TEXT NOT NULL,
    "requisition_surface_form" TEXT,
    "requisition_canonical_skill_id" UUID,
    "talent_canonical_skill_id" UUID,
    "observed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CanonicalMatchShadowObservation_pkey" PRIMARY KEY ("id")
);

-- Governed-vocab CHECK — the 7 provable v1 match classes.
ALTER TABLE "examination"."CanonicalMatchShadowObservation"
    ADD CONSTRAINT "CanonicalMatchShadowObservation_match_class_check"
    CHECK ("match_class" IN (
        'CANONICAL_EXACT',
        'ALIAS_EQUIVALENT',
        'CANONICAL_DIFFERENCE',
        'UNRESOLVED_TALENT',
        'UNRESOLVED_REQUISITION',
        'UNRESOLVED_BOTH',
        'SOURCE_SET_DIVERGENCE'
    ));

-- CreateIndex
CREATE INDEX "CanonicalMatchShadowObservation_tenant_id_examination_id_idx" ON "examination"."CanonicalMatchShadowObservation"("tenant_id", "examination_id");

-- CreateIndex
CREATE INDEX "CanonicalMatchShadowObservation_tenant_id_match_class_idx" ON "examination"."CanonicalMatchShadowObservation"("tenant_id", "match_class");

-- Absolute-immutability trigger — append-only. Every UPDATE is rejected
-- unconditionally (an observation is never mutated post-insert).
CREATE OR REPLACE FUNCTION "examination"."reject_canonical_match_shadow_update"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'CanonicalMatchShadowObservation is append-only (UPDATE rejected)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "canonical_match_shadow_no_update"
    BEFORE UPDATE ON "examination"."CanonicalMatchShadowObservation"
    FOR EACH ROW
    EXECUTE FUNCTION "examination"."reject_canonical_match_shadow_update"();
