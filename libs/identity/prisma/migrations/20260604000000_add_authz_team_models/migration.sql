-- AUTHZ-D4a — additive substrate migration for the identity-side team models.
-- Three greenfield tables: ManagementEdge (Axis-1 hierarchy), Team + TeamMembership
-- (Axis-2 account-ownership pods, AM-anchored). All intra-schema; the company-side
-- of the substrate (UserClientAssignment, TeamClientOwnership) lives in the
-- company schema with cross-schema logical refs to identity.User / identity.Team
-- (no FK; Architecture §7.3). D4a is WRITE-SIDE only — no entity visibility
-- changes (D4b's composed predicate flips visibility on later).

-- CreateTable: ManagementEdge — Axis-1 management hierarchy.
CREATE TABLE "identity"."ManagementEdge" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "manager_user_id" UUID NOT NULL,
    "report_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "ManagementEdge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: ManagementEdge D4b read paths.
CREATE INDEX "ManagementEdge_tenant_id_manager_user_id_idx" ON "identity"."ManagementEdge"("tenant_id", "manager_user_id");
CREATE INDEX "ManagementEdge_tenant_id_report_user_id_idx" ON "identity"."ManagementEdge"("tenant_id", "report_user_id");
CREATE UNIQUE INDEX "ManagementEdge_manager_user_id_report_user_id_key" ON "identity"."ManagementEdge"("manager_user_id", "report_user_id");

-- AddForeignKey: ManagementEdge intra-schema FKs (both endpoints to identity.User).
ALTER TABLE "identity"."ManagementEdge" ADD CONSTRAINT "ManagementEdge_manager_user_id_fkey" FOREIGN KEY ("manager_user_id") REFERENCES "identity"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "identity"."ManagementEdge" ADD CONSTRAINT "ManagementEdge_report_user_id_fkey" FOREIGN KEY ("report_user_id") REFERENCES "identity"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: Team — Axis-2 account-ownership pod (AM-anchored).
CREATE TABLE "identity"."Team" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Team — per-tenant unique pod name + D4b read paths.
CREATE UNIQUE INDEX "Team_tenant_id_name_key" ON "identity"."Team"("tenant_id", "name");
CREATE INDEX "Team_tenant_id_owner_user_id_idx" ON "identity"."Team"("tenant_id", "owner_user_id");
CREATE INDEX "Team_tenant_id_is_active_idx" ON "identity"."Team"("tenant_id", "is_active");

-- AddForeignKey: Team.owner_user_id intra-schema FK to identity.User.
ALTER TABLE "identity"."Team" ADD CONSTRAINT "Team_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "identity"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: TeamMembership — pod membership (many-to-many user ↔ Team).
CREATE TABLE "identity"."TeamMembership" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "added_by_id" UUID,

    CONSTRAINT "TeamMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: TeamMembership idempotency + D4b read path.
CREATE UNIQUE INDEX "TeamMembership_team_id_user_id_key" ON "identity"."TeamMembership"("team_id", "user_id");
CREATE INDEX "TeamMembership_tenant_id_user_id_idx" ON "identity"."TeamMembership"("tenant_id", "user_id");

-- AddForeignKey: TeamMembership intra-schema FKs (Team cascade; User restrict).
ALTER TABLE "identity"."TeamMembership" ADD CONSTRAINT "TeamMembership_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "identity"."Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "identity"."TeamMembership" ADD CONSTRAINT "TeamMembership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
