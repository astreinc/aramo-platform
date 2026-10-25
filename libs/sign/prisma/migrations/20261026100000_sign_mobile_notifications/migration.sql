-- Aramo Sign Mobile — the notification feed, push devices, notification preferences
-- and push delivery (Aramo-Sign-Unified-Product-Amendment-M-A3-Mobile-Owned-Data-
-- Contracts-v1_0-LOCKED §1, §2, §9).
-- ADDITIVE ONLY: six new tables in the sign schema. No existing table or column is altered.
-- splitDdl-safe: no semicolons in comment lines.
--
-- SignNotificationOutbox      the fan-out source, written in the ledger-event transaction (refs only)
-- SignUserNotification        one feed row per (user, source event), owned by (tenant_id, user_id)
-- SignPushDevice              a push registration bound to one native device session (token encrypted)
-- SignNotificationPreference  per-user push preferences (absent row = defaults)
-- SignPushJob                 one push of one notification to one device, with retry state
-- SignConvenienceDataPurge    the counts-only audit of an account-close purge


-- CreateTable
CREATE TABLE "sign"."SignNotificationOutbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "envelope_id" UUID NOT NULL,
    "signer_id" UUID,
    "kind" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_ref" UUID,
    "signer_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ,
    "last_error_code" VARCHAR(64),

    CONSTRAINT "SignNotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign"."SignUserNotification" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "envelope_id" UUID NOT NULL,
    "inbox_item_id" UUID,
    "envelope_subject" TEXT NOT NULL,
    "actor_name" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "source_outbox_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ,

    CONSTRAINT "SignUserNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign"."SignPushDevice" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_session_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "push_token_ciphertext" TEXT,
    "push_token_digest" TEXT,
    "app_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,
    "revoke_reason" TEXT,

    CONSTRAINT "SignPushDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign"."SignNotificationPreference" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "signed" BOOLEAN NOT NULL DEFAULT true,
    "viewed" BOOLEAN NOT NULL DEFAULT true,
    "declined" BOOLEAN NOT NULL DEFAULT true,
    "signature_needed" BOOLEAN NOT NULL DEFAULT true,
    "reminders" BOOLEAN NOT NULL DEFAULT true,
    "lock_screen_subject" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignNotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign"."SignPushJob" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "payload_kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ,

    CONSTRAINT "SignPushJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sign"."SignConvenienceDataPurge" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "devices_revoked" INTEGER NOT NULL,
    "push_jobs_cancelled" INTEGER NOT NULL,
    "devices_deleted" INTEGER NOT NULL,
    "notifications_deleted" INTEGER NOT NULL,
    "preferences_deleted" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignConvenienceDataPurge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SignNotificationOutbox_processed_at_next_attempt_at_idx" ON "sign"."SignNotificationOutbox"("processed_at", "next_attempt_at");

-- CreateIndex
CREATE INDEX "SignUserNotification_tenant_id_user_id_created_at_idx" ON "sign"."SignUserNotification"("tenant_id", "user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "SignUserNotification_user_dedupe_key" ON "sign"."SignUserNotification"("user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "SignPushDevice_tenant_id_user_id_idx" ON "sign"."SignPushDevice"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "SignPushDevice_push_token_digest_idx" ON "sign"."SignPushDevice"("push_token_digest");

-- CreateIndex
CREATE UNIQUE INDEX "SignPushDevice_device_session_key" ON "sign"."SignPushDevice"("device_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "SignNotificationPreference_owner_key" ON "sign"."SignNotificationPreference"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "SignPushJob_status_next_attempt_at_idx" ON "sign"."SignPushJob"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "SignPushJob_tenant_id_user_id_created_at_idx" ON "sign"."SignPushJob"("tenant_id", "user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "SignPushJob_device_notification_key" ON "sign"."SignPushJob"("device_id", "notification_id");

-- CreateIndex
CREATE INDEX "SignConvenienceDataPurge_tenant_id_user_id_idx" ON "sign"."SignConvenienceDataPurge"("tenant_id", "user_id");

-- AddForeignKey
ALTER TABLE "sign"."SignPushJob" ADD CONSTRAINT "SignPushJob_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "sign"."SignPushDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sign"."SignPushJob" ADD CONSTRAINT "SignPushJob_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "sign"."SignUserNotification"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Closed vocabularies.
ALTER TABLE "sign"."SignNotificationOutbox" ADD CONSTRAINT "SignNotificationOutbox_kind_check" CHECK ("kind" IN ('SIGNED', 'VIEWED', 'DECLINED', 'SIGNATURE_NEEDED', 'COMPLETED', 'EXPIRED', 'REMINDER'));
ALTER TABLE "sign"."SignUserNotification" ADD CONSTRAINT "SignUserNotification_type_check" CHECK ("type" IN ('SIGNED', 'VIEWED', 'DECLINED', 'SIGNATURE_NEEDED', 'COMPLETED', 'EXPIRED', 'REMINDER'));
ALTER TABLE "sign"."SignUserNotification" ADD CONSTRAINT "SignUserNotification_audience_check" CHECK ("audience" IN ('SENDER', 'RECIPIENT'));
ALTER TABLE "sign"."SignPushDevice" ADD CONSTRAINT "SignPushDevice_platform_check" CHECK ("platform" IN ('ios', 'android'));
ALTER TABLE "sign"."SignPushDevice" ADD CONSTRAINT "SignPushDevice_provider_check" CHECK ("provider" IN ('apns', 'fcm'));
-- A revoked device holds no provider token material.
ALTER TABLE "sign"."SignPushDevice" ADD CONSTRAINT "SignPushDevice_revoked_token_check" CHECK ("revoked_at" IS NULL OR ("push_token_ciphertext" IS NULL AND "push_token_digest" IS NULL));
ALTER TABLE "sign"."SignPushJob" ADD CONSTRAINT "SignPushJob_status_check" CHECK ("status" IN ('PENDING', 'SENT', 'CANCELLED', 'FAILED', 'DEAD'));
