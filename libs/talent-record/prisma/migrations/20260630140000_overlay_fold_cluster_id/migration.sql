-- ADR-0016 step 4d — TalentTenantOverlay fold + cluster_id pointer.
--
-- Additive only. Folds the overlay's tenant-relationship fields onto the
-- TalentRecord (the ATS heart) and adds the cross-tenant identity pointer
-- cluster_id (→ identity_index.PersonCluster, UUID-only, no FK per §7.3).
-- The overlay TABLE is NOT dropped here (the ingestion/canonicalize path still
-- writes a per-tenant Core-husk overlay); it retires in 4e. core_talent_id is
-- UNTOUCHED (consent reads it; owned by the consent re-key directive).

-- AlterTable
ALTER TABLE "talent_record"."TalentRecord"
    ADD COLUMN "source_channel" TEXT,
    ADD COLUMN "tenant_status" TEXT,
    ADD COLUMN "source_recruiter_id" UUID,
    ADD COLUMN "cluster_id" UUID;

-- CreateIndex
CREATE INDEX "TalentRecord_tenant_id_cluster_id_idx" ON "talent_record"."TalentRecord"("tenant_id", "cluster_id");
