-- PR-A5b-2 — additive Core-Talent link column on TalentRecord (the
-- keystone of the ATS↔Core seam).
--
-- ADDITIVE: ALTER TABLE ADD COLUMN + CREATE INDEX. Core untouched —
-- this migration does NOT modify `talent`.`Talent` or
-- `talent`.`TalentTenantOverlay`. The reference is a UUID-only logical
-- cross-schema pointer (Architecture v2.0 §7.3 — UUID-only, no FK).
--
-- Nullable: an UNLINKED TalentRecord is valid. The link is set by
-- TalentLinkService via the dedicated /link routes, never by the free
-- PATCH /v1/talent-records/:id surface (which deliberately omits
-- core_talent_id from UpdateTalentRecordRequestDto).

-- AlterTable
ALTER TABLE "talent_record"."TalentRecord"
    ADD COLUMN "core_talent_id" UUID;

-- CreateIndex
CREATE INDEX "TalentRecord_tenant_id_core_talent_id_idx"
    ON "talent_record"."TalentRecord"("tenant_id", "core_talent_id");
