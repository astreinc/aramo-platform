-- Promotion-Trigger slice B-api — keyset-pagination support for the sourcing-pool
-- list reader. The reader lists ACTIVE ResolutionSubjects (a sourced pool member
-- with no ATS_TALENT_RECORD ref) oldest-first with a (created_at, id) keyset
-- cursor. This composite index serves the tenant+status filter plus the ordered
-- scan without a sort. Additive index only, no column or table change.

-- CreateIndex
CREATE INDEX "ResolutionSubject_tenant_id_status_created_at_id_idx"
    ON "talent_trust"."ResolutionSubject" ("tenant_id", "status", "created_at", "id");
