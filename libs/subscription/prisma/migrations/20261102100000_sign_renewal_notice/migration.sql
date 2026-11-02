-- Aramo Sign Remaining-Work Consolidated Directive v1.0 (LOCKED, 32e5e3e1) Workstream A3 — the
-- Aramo renewal notice: an email to the subscribing owner before an auto-continuing subscription's
-- term boundary (today: the end of the 12-month commitment, after which it continues month to month,
-- ToS v2.0 B5.1), with delivery evidence.
--
-- ADDITIVE ONLY. One new table, no change to any existing table or returned shape:
--   "RenewalNoticeDelivery"  one row per (subscription, notice kind, term end, channel): the
--                            delivery evidence. The address and the email body are never stored,
--                            only the template id, version and SHA-256 of what was sent.
--
-- Idempotency: UNIQUE (subscription_id, notice_kind, term_end, channel) — a re-run never sends twice
-- for the same term end. notice_kind is COMMITMENT_END today; a later annual-term schedule (A2, gated
-- on a Lead ruling) adds its kind by an additive CHECK widening and reuses the table unchanged.
-- Integrity: a trigger refuses DELETE, refuses changes to the identifying columns and refuses any
-- status change out of a terminal state (SENT, SUPPRESSED).
--
-- Carries a dollar-quoted function body: apply whole-file (pg Client), never a line splitter.
-- Nothing in this migration sends or schedules anything (the job is dark unless
-- SIGN_RENEWAL_NOTICES_ENABLED=1).

CREATE TABLE "subscription"."RenewalNoticeDelivery" (
    "id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    "notice_kind" TEXT NOT NULL,
    -- The term boundary the notice is about (COMMITMENT_END: TenantSubscription.commitment_end).
    "term_end" TIMESTAMPTZ(6) NOT NULL,
    -- The lead time in force when the notice was claimed (SIGN_RENEWAL_NOTICE_DAYS).
    "lead_days" INTEGER NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "template_id" TEXT NOT NULL,
    "template_version" TEXT NOT NULL,
    "template_sha256" TEXT NOT NULL,
    -- The mailer that accepted it (ses, stub, outbox) and its message id.
    "provider" TEXT,
    "provider_message_id" TEXT,
    "status" TEXT NOT NULL,
    "error_code" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    CONSTRAINT "RenewalNoticeDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RenewalNoticeDelivery_subscription_id_fkey" FOREIGN KEY ("subscription_id")
        REFERENCES "subscription"."TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "RenewalNoticeDelivery_notice_kind_check" CHECK ("notice_kind" IN ('COMMITMENT_END')),
    CONSTRAINT "RenewalNoticeDelivery_channel_check" CHECK ("channel" IN ('EMAIL')),
    CONSTRAINT "RenewalNoticeDelivery_status_check" CHECK ("status" IN ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED')),
    CONSTRAINT "RenewalNoticeDelivery_sent_check" CHECK (("status" = 'SENT') = ("sent_at" IS NOT NULL)),
    CONSTRAINT "RenewalNoticeDelivery_message_check" CHECK ("status" <> 'SENT' OR "provider_message_id" IS NOT NULL),
    CONSTRAINT "RenewalNoticeDelivery_lead_days_check" CHECK ("lead_days" BETWEEN 1 AND 365),
    CONSTRAINT "RenewalNoticeDelivery_attempt_count_check" CHECK ("attempt_count" >= 1)
);

CREATE UNIQUE INDEX "RenewalNoticeDelivery_subscription_id_notice_kind_term_end_channel_key"
    ON "subscription"."RenewalNoticeDelivery"("subscription_id", "notice_kind", "term_end", "channel");
CREATE INDEX "RenewalNoticeDelivery_tenant_id_idx"
    ON "subscription"."RenewalNoticeDelivery"("tenant_id");
CREATE INDEX "RenewalNoticeDelivery_status_idx"
    ON "subscription"."RenewalNoticeDelivery"("status");

-- Evidence integrity guard.
CREATE OR REPLACE FUNCTION "subscription"."renewal_notice_delivery_guard"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'RenewalNoticeDelivery is delivery evidence and cannot be deleted';
    END IF;
    IF NEW."subscription_id" IS DISTINCT FROM OLD."subscription_id"
        OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
        OR NEW."product_key" IS DISTINCT FROM OLD."product_key"
        OR NEW."notice_kind" IS DISTINCT FROM OLD."notice_kind"
        OR NEW."term_end" IS DISTINCT FROM OLD."term_end"
        OR NEW."channel" IS DISTINCT FROM OLD."channel"
        OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'RenewalNoticeDelivery identifying columns are immutable';
    END IF;
    IF OLD."status" IN ('SENT', 'SUPPRESSED') AND (
        NEW."status" IS DISTINCT FROM OLD."status"
        OR NEW."provider_message_id" IS DISTINCT FROM OLD."provider_message_id"
        OR NEW."sent_at" IS DISTINCT FROM OLD."sent_at"
        OR NEW."template_sha256" IS DISTINCT FROM OLD."template_sha256") THEN
        RAISE EXCEPTION 'RenewalNoticeDelivery % is terminal', OLD."status";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RenewalNoticeDelivery_guard"
    BEFORE UPDATE OR DELETE ON "subscription"."RenewalNoticeDelivery"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."renewal_notice_delivery_guard"();
