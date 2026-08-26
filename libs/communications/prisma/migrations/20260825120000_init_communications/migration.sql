-- COMM-V1 — initial migration for the `communications` PG schema (Aramo
-- Communications / Voice, provider-neutral domain substrate, COMM-B1).
--
-- ADDITIVE at the DB level: CREATE SCHEMA + CREATE TYPE + CREATE TABLE only.
-- Nothing in any existing namespace is altered.
--
-- Locked rulings baked in (Aramo-COMM-V1-Communications-Voice-Directive-v1_0-LOCKED):
--   * CommunicationInteraction.id is the canonical calling identity — provider
--     ids (call_id / call_history_uuid / call_element_id) are correlation
--     metadata only (R-COMM-ZOOM-IDENTITY)
--   * provider-event idempotency is UNIQUE(tenant_id, integration_connection_id,
--     provider_event_key) (R-COMM-WEBHOOK)
--   * NO raw credential column and NO raw provider payload blob anywhere
--     (R-COMM-CONNECTION / R-COMM-RAW-PAYLOAD) — payload_reference is opaque
--   * integration_connection_id references integration.IntegrationConnection by
--     UUID only, no FK (R-COMM-CONNECTION)
--
-- New PG schema: `communications`.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "communications";

-- CreateEnum
CREATE TYPE "communications"."CommunicationChannel" AS ENUM ('voice', 'sms', 'email');

-- CreateEnum
CREATE TYPE "communications"."CommunicationDirection" AS ENUM ('outbound', 'inbound');

-- CreateEnum
CREATE TYPE "communications"."CommunicationInteractionStatus" AS ENUM ('created', 'initiated', 'ringing', 'connected', 'completed', 'failed', 'missed', 'rejected');

-- CreateEnum
CREATE TYPE "communications"."CommunicationSubjectType" AS ENUM ('talent_record', 'requisition', 'pipeline');

-- CreateEnum
CREATE TYPE "communications"."CommunicationRelationType" AS ENUM ('subject', 'regarding');

-- CreateEnum
CREATE TYPE "communications"."CommunicationDispositionOutcome" AS ENUM ('connected', 'left_voicemail', 'no_answer', 'busy', 'wrong_number', 'interested', 'not_interested', 'callback_requested', 'follow_up_required', 'do_not_contact');

-- CreateEnum
CREATE TYPE "communications"."CommunicationProviderEventStatus" AS ENUM ('received', 'processing', 'processed', 'failed', 'ignored');

-- CreateEnum
CREATE TYPE "communications"."CommunicationProviderIdentityStatus" AS ENUM ('active', 'unmapped', 'disabled', 'reauth_required');

-- CreateTable
CREATE TABLE "communications"."CommunicationInteraction" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "channel" "communications"."CommunicationChannel" NOT NULL,
    "direction" "communications"."CommunicationDirection" NOT NULL,
    "status" "communications"."CommunicationInteractionStatus" NOT NULL DEFAULT 'created',
    "integration_connection_id" UUID NOT NULL,
    "provider_interaction_id" TEXT,
    "provider_call_id" TEXT,
    "provider_call_history_uuid" TEXT,
    "provider_call_element_id" TEXT,
    "initiated_by_id" UUID,
    "from_address" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ,
    "ringing_at" TIMESTAMPTZ,
    "connected_at" TIMESTAMPTZ,
    "ended_at" TIMESTAMPTZ,
    "duration_seconds" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communications"."CommunicationAssociation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "interaction_id" UUID NOT NULL,
    "subject_type" "communications"."CommunicationSubjectType" NOT NULL,
    "subject_id" UUID NOT NULL,
    "relation_type" "communications"."CommunicationRelationType" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationAssociation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communications"."CommunicationDisposition" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "interaction_id" UUID NOT NULL,
    "disposition" "communications"."CommunicationDispositionOutcome" NOT NULL,
    "notes" TEXT,
    "dispositioned_by_id" UUID NOT NULL,
    "dispositioned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationDisposition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communications"."CommunicationProviderEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "integration_connection_id" UUID NOT NULL,
    "provider_event_key" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "interaction_id" UUID,
    "status" "communications"."CommunicationProviderEventStatus" NOT NULL DEFAULT 'received',
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "payload_reference" TEXT,

    CONSTRAINT "CommunicationProviderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communications"."CommunicationProviderIdentity" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "integration_connection_id" UUID NOT NULL,
    "recruiter_id" UUID NOT NULL,
    "provider_user_id" TEXT NOT NULL,
    "provider_extension_id" TEXT,
    "display_phone_number" TEXT,
    "extension" TEXT,
    "voice_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sms_enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "communications"."CommunicationProviderIdentityStatus" NOT NULL DEFAULT 'unmapped',
    "last_verified_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationProviderIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommunicationInteraction_tenant_id_status_idx" ON "communications"."CommunicationInteraction"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "CommInteraction_conn_call_element_idx" ON "communications"."CommunicationInteraction"("tenant_id", "integration_connection_id", "provider_call_element_id");

-- CreateIndex
CREATE INDEX "CommInteraction_conn_call_history_idx" ON "communications"."CommunicationInteraction"("tenant_id", "integration_connection_id", "provider_call_history_uuid");

-- CreateIndex
CREATE INDEX "CommInteraction_conn_call_id_idx" ON "communications"."CommunicationInteraction"("tenant_id", "integration_connection_id", "provider_call_id");

-- CreateIndex
CREATE INDEX "CommunicationAssociation_tenant_id_subject_type_subject_id_idx" ON "communications"."CommunicationAssociation"("tenant_id", "subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "CommunicationAssociation_tenant_id_interaction_id_idx" ON "communications"."CommunicationAssociation"("tenant_id", "interaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationAssociation_interaction_id_subject_type_subjec_key" ON "communications"."CommunicationAssociation"("interaction_id", "subject_type", "subject_id", "relation_type");

-- CreateIndex
CREATE INDEX "CommunicationDisposition_tenant_id_interaction_id_idx" ON "communications"."CommunicationDisposition"("tenant_id", "interaction_id");

-- CreateIndex
CREATE INDEX "CommunicationProviderEvent_tenant_id_integration_connection_idx" ON "communications"."CommunicationProviderEvent"("tenant_id", "integration_connection_id", "status");

-- CreateIndex
CREATE INDEX "CommunicationProviderEvent_tenant_id_interaction_id_idx" ON "communications"."CommunicationProviderEvent"("tenant_id", "interaction_id");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationProviderEvent_tenant_id_integration_connection_key" ON "communications"."CommunicationProviderEvent"("tenant_id", "integration_connection_id", "provider_event_key");

-- CreateIndex
CREATE INDEX "CommunicationProviderIdentity_tenant_id_recruiter_id_idx" ON "communications"."CommunicationProviderIdentity"("tenant_id", "recruiter_id");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationProviderIdentity_integration_connection_id_rec_key" ON "communications"."CommunicationProviderIdentity"("integration_connection_id", "recruiter_id");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationProviderIdentity_integration_connection_id_pro_key" ON "communications"."CommunicationProviderIdentity"("integration_connection_id", "provider_user_id");

-- AddForeignKey
ALTER TABLE "communications"."CommunicationAssociation" ADD CONSTRAINT "CommunicationAssociation_interaction_id_fkey" FOREIGN KEY ("interaction_id") REFERENCES "communications"."CommunicationInteraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications"."CommunicationDisposition" ADD CONSTRAINT "CommunicationDisposition_interaction_id_fkey" FOREIGN KEY ("interaction_id") REFERENCES "communications"."CommunicationInteraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications"."CommunicationProviderEvent" ADD CONSTRAINT "CommunicationProviderEvent_interaction_id_fkey" FOREIGN KEY ("interaction_id") REFERENCES "communications"."CommunicationInteraction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

