-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "metering";

-- CreateTable
CREATE TABLE "metering"."UsageEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageEvent_tenant_id_occurred_at_idx" ON "metering"."UsageEvent"("tenant_id", "occurred_at");
