-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "talent";

-- CreateTable
CREATE TABLE "talent"."Talent" (
    "id" UUID NOT NULL,
    "lifecycle_status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Talent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent"."TalentTenantOverlay" (
    "id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source_recruiter_id" UUID,
    "source_channel" TEXT NOT NULL,
    "tenant_status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "TalentTenantOverlay_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TalentTenantOverlay_tenant_id_idx" ON "talent"."TalentTenantOverlay"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "TalentTenantOverlay_talent_id_tenant_id_key" ON "talent"."TalentTenantOverlay"("talent_id", "tenant_id");

-- AddForeignKey
ALTER TABLE "talent"."TalentTenantOverlay" ADD CONSTRAINT "TalentTenantOverlay_talent_id_fkey" FOREIGN KEY ("talent_id") REFERENCES "talent"."Talent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

