-- Contact-spec amendment v1.0 (LOCKED) — list/detail surface fields for the
-- Contacts page (relationship_role, preference, last_activity_at).
--
-- ADDITIVE ONLY: ALTER TABLE ADD COLUMN (all nullable) + CREATE INDEX. No
-- backfill, no drops, no Prisma enum (String + application-layer @IsIn closed
-- vocab). last_activity_at mirrors company.last_activity_at (Timestamptz,
-- read-model recency rollup).

-- AlterTable
ALTER TABLE "contact"."Contact"
    ADD COLUMN "relationship_role" TEXT,
    ADD COLUMN "preference" TEXT,
    ADD COLUMN "last_activity_at" TIMESTAMPTZ;

-- CreateIndex — facet-filtered + recency-sorted lookups.
CREATE INDEX "Contact_tenant_id_relationship_role_idx"
    ON "contact"."Contact"("tenant_id", "relationship_role");

CREATE INDEX "Contact_tenant_id_preference_idx"
    ON "contact"."Contact"("tenant_id", "preference");

CREATE INDEX "Contact_tenant_id_owner_id_idx"
    ON "contact"."Contact"("tenant_id", "owner_id");

CREATE INDEX "Contact_tenant_id_last_activity_at_idx"
    ON "contact"."Contact"("tenant_id", "last_activity_at");
