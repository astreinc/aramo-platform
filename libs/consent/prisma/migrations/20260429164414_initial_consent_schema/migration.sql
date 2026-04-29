-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "audit";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "consent";

-- CreateTable
CREATE TABLE "consent"."TalentConsentEvent" (
    "id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "captured_by_actor_id" UUID,
    "captured_method" TEXT NOT NULL,
    "consent_version" TEXT NOT NULL,
    "consent_text_snapshot" TEXT,
    "consent_document_id" UUID,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TalentConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent"."IdempotencyKey" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent"."OutboxEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit"."ConsentAuditEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TalentConsentEvent_tenant_id_talent_id_occurred_at_idx" ON "consent"."TalentConsentEvent"("tenant_id", "talent_id", "occurred_at");

-- CreateIndex
CREATE INDEX "TalentConsentEvent_tenant_id_scope_action_idx" ON "consent"."TalentConsentEvent"("tenant_id", "scope", "action");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_tenant_id_key_key" ON "consent"."IdempotencyKey"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "OutboxEvent_published_at_idx" ON "consent"."OutboxEvent"("published_at");

-- CreateIndex
CREATE INDEX "ConsentAuditEvent_tenant_id_subject_id_created_at_idx" ON "audit"."ConsentAuditEvent"("tenant_id", "subject_id", "created_at");

-- ============================================================================
-- TalentConsentEvent immutability — belt-and-suspenders enforcement.
-- PR-2 precedent decision #4: the consent ledger is immutable. Enforced by:
--   1. Repository layer exposes no update method (libs/consent/src/lib/consent.repository.ts)
--   2. Database BEFORE UPDATE trigger raises an exception on any UPDATE
-- ============================================================================
CREATE OR REPLACE FUNCTION consent.talent_consent_event_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'TalentConsentEvent is immutable; UPDATE rejected';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER talent_consent_event_no_update
  BEFORE UPDATE ON consent."TalentConsentEvent"
  FOR EACH ROW EXECUTE FUNCTION consent.talent_consent_event_immutable();
