-- AUTHZ-D4a — additive substrate migration for the company-side team models.
-- Two greenfield join tables: UserClientAssignment (direct-assignment axis),
-- TeamClientOwnership (Axis-2 pod -> client ownership). Both are company-side
-- per the Option A schema placement (mirror RequisitionAssignment in
-- libs/requisition — the join lives WITH the intra-schema-FK entity).
--
-- Cross-schema references (Architecture §7.3): user_id and team_id are
-- CROSS-SCHEMA logical references to identity.User and identity.Team — UUID-
-- only, NO FK constraint at the DB layer. company_id is an intra-schema FK
-- to Company. D4a is WRITE-SIDE only — no entity visibility changes (D4b
-- wires the predicate that reads these models).

-- CreateTable: UserClientAssignment — the direct-assignment axis.
CREATE TABLE "company"."UserClientAssignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by_id" UUID,

    CONSTRAINT "UserClientAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: UserClientAssignment idempotency + D4b read paths.
CREATE UNIQUE INDEX "UserClientAssignment_user_id_company_id_key" ON "company"."UserClientAssignment"("user_id", "company_id");
CREATE INDEX "UserClientAssignment_tenant_id_user_id_idx" ON "company"."UserClientAssignment"("tenant_id", "user_id");
CREATE INDEX "UserClientAssignment_tenant_id_company_id_idx" ON "company"."UserClientAssignment"("tenant_id", "company_id");

-- AddForeignKey: UserClientAssignment.company_id intra-schema FK (cascade on
-- company delete; user_id is a cross-schema logical ref — no FK).
ALTER TABLE "company"."UserClientAssignment" ADD CONSTRAINT "UserClientAssignment_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: TeamClientOwnership — Axis-2 pod -> client linkage.
CREATE TABLE "company"."TeamClientOwnership" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by_id" UUID,

    CONSTRAINT "TeamClientOwnership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: TeamClientOwnership idempotency + D4b read paths.
CREATE UNIQUE INDEX "TeamClientOwnership_team_id_company_id_key" ON "company"."TeamClientOwnership"("team_id", "company_id");
CREATE INDEX "TeamClientOwnership_tenant_id_team_id_idx" ON "company"."TeamClientOwnership"("tenant_id", "team_id");
CREATE INDEX "TeamClientOwnership_tenant_id_company_id_idx" ON "company"."TeamClientOwnership"("tenant_id", "company_id");

-- AddForeignKey: TeamClientOwnership.company_id intra-schema FK (cascade on
-- company delete; team_id is a cross-schema logical ref to identity.Team —
-- no FK at the DB layer per Architecture §7.3).
ALTER TABLE "company"."TeamClientOwnership" ADD CONSTRAINT "TeamClientOwnership_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
