-- Privacy Notice 1.1 remediation, item E-6 (Aramo-Privacy-Notice-1_1-Remediation-Directive-v1_0-LOCKED,
-- decision 7 and section 3) — advance notice of a legal-document change to every active account
-- holder, with delivery evidence.
--
-- ADDITIVE ONLY. Two new tables, no change to any existing table or returned shape:
--   1. "LegalChangeNoticeRun"      one row per operator run of the notice command (dry run or send),
--                                  carrying COUNTS only (the run-level audit event). No recipient
--                                  identifiers, no addresses, no email content.
--   2. "LegalChangeNoticeDelivery" one row per (document, version, channel, recipient user): the
--                                  delivery evidence. Channel EMAIL (written by the operator command)
--                                  or IN_SERVICE (written by the Sign workspace banner when shown and
--                                  when acknowledged). The email body is never stored, only the
--                                  template id, version and SHA-256 of the template that was sent.
--
-- Idempotency: UNIQUE (document_key, version, channel, user_id) — a re-run never sends twice.
-- Integrity: a trigger refuses DELETE, refuses changes to the identifying columns and refuses any
-- status change out of a terminal state (SENT, SUPPRESSED). The only later write on a SENT row is
-- the in-service acknowledgement time.
--
-- Carries a dollar-quoted function body: apply whole-file (pg Client), never a line splitter.
-- Nothing in this migration sends anything or schedules anything.

CREATE TABLE "subscription"."LegalChangeNoticeRun" (
    "id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "document_key" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "effective_date" DATE NOT NULL,
    "template_id" TEXT NOT NULL,
    "template_version" TEXT NOT NULL,
    "template_sha256" TEXT NOT NULL,
    "template_status" TEXT NOT NULL,
    -- The operator's authorization reference (send mode only), never personal data.
    "authorization_ref" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "eligible_count" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "suppressed_count" INTEGER NOT NULL DEFAULT 0,
    "already_done_count" INTEGER NOT NULL DEFAULT 0,
    "in_doubt_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    CONSTRAINT "LegalChangeNoticeRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LegalChangeNoticeRun_mode_check" CHECK ("mode" IN ('DRY_RUN', 'SEND')),
    CONSTRAINT "LegalChangeNoticeRun_status_check" CHECK ("status" IN ('RUNNING', 'COMPLETED', 'ABORTED')),
    CONSTRAINT "LegalChangeNoticeRun_template_status_check" CHECK ("template_status" IN ('DRAFT', 'APPROVED')),
    CONSTRAINT "LegalChangeNoticeRun_counts_check" CHECK (
        "eligible_count" >= 0 AND "sent_count" >= 0 AND "failed_count" >= 0 AND "suppressed_count" >= 0
        AND "already_done_count" >= 0 AND "in_doubt_count" >= 0)
);

CREATE INDEX "LegalChangeNoticeRun_document_key_version_started_at_idx"
    ON "subscription"."LegalChangeNoticeRun"("document_key", "version", "started_at" DESC);

CREATE TABLE "subscription"."LegalChangeNoticeDelivery" (
    "id" UUID NOT NULL,
    "document_key" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "effective_date" DATE NOT NULL,
    "channel" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    -- EMAIL: the run that last attempted this delivery. IN_SERVICE: NULL.
    "run_id" UUID,
    "template_id" TEXT,
    "template_version" TEXT,
    "template_sha256" TEXT,
    -- EMAIL: the mailer that accepted it (ses, stub, outbox) and its message id.
    "provider" TEXT,
    "provider_message_id" TEXT,
    "status" TEXT NOT NULL,
    "error_code" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    "acknowledged_at" TIMESTAMPTZ(3),
    CONSTRAINT "LegalChangeNoticeDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LegalChangeNoticeDelivery_run_id_fkey" FOREIGN KEY ("run_id")
        REFERENCES "subscription"."LegalChangeNoticeRun"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "LegalChangeNoticeDelivery_channel_check" CHECK ("channel" IN ('EMAIL', 'IN_SERVICE')),
    CONSTRAINT "LegalChangeNoticeDelivery_status_check" CHECK ("status" IN ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED')),
    CONSTRAINT "LegalChangeNoticeDelivery_sent_check" CHECK (("status" = 'SENT') = ("sent_at" IS NOT NULL)),
    CONSTRAINT "LegalChangeNoticeDelivery_email_template_check" CHECK (
        "channel" <> 'EMAIL' OR ("template_id" IS NOT NULL AND "template_version" IS NOT NULL AND "template_sha256" IS NOT NULL AND "run_id" IS NOT NULL)),
    CONSTRAINT "LegalChangeNoticeDelivery_email_message_check" CHECK (
        "channel" <> 'EMAIL' OR "status" <> 'SENT' OR "provider_message_id" IS NOT NULL),
    CONSTRAINT "LegalChangeNoticeDelivery_ack_check" CHECK ("acknowledged_at" IS NULL OR "channel" = 'IN_SERVICE'),
    CONSTRAINT "LegalChangeNoticeDelivery_attempt_count_check" CHECK ("attempt_count" >= 1)
);

CREATE UNIQUE INDEX "LegalChangeNoticeDelivery_document_key_version_channel_user_id_key"
    ON "subscription"."LegalChangeNoticeDelivery"("document_key", "version", "channel", "user_id");
CREATE INDEX "LegalChangeNoticeDelivery_tenant_id_idx"
    ON "subscription"."LegalChangeNoticeDelivery"("tenant_id");
CREATE INDEX "LegalChangeNoticeDelivery_document_key_version_status_idx"
    ON "subscription"."LegalChangeNoticeDelivery"("document_key", "version", "status");

-- Evidence integrity guard.
CREATE OR REPLACE FUNCTION "subscription"."legal_change_notice_delivery_guard"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'LegalChangeNoticeDelivery is delivery evidence and cannot be deleted';
    END IF;
    IF NEW."document_key" IS DISTINCT FROM OLD."document_key"
        OR NEW."version" IS DISTINCT FROM OLD."version"
        OR NEW."effective_date" IS DISTINCT FROM OLD."effective_date"
        OR NEW."channel" IS DISTINCT FROM OLD."channel"
        OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
        OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
        OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'LegalChangeNoticeDelivery identifying columns are immutable';
    END IF;
    IF OLD."status" IN ('SENT', 'SUPPRESSED') THEN
        IF NEW."status" IS DISTINCT FROM OLD."status"
            OR NEW."provider_message_id" IS DISTINCT FROM OLD."provider_message_id"
            OR NEW."sent_at" IS DISTINCT FROM OLD."sent_at"
            OR NEW."template_sha256" IS DISTINCT FROM OLD."template_sha256" THEN
            RAISE EXCEPTION 'LegalChangeNoticeDelivery % is terminal', OLD."status";
        END IF;
        IF OLD."acknowledged_at" IS NOT NULL AND NEW."acknowledged_at" IS DISTINCT FROM OLD."acknowledged_at" THEN
            RAISE EXCEPTION 'LegalChangeNoticeDelivery acknowledgement time is immutable once set';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LegalChangeNoticeDelivery_guard"
    BEFORE UPDATE OR DELETE ON "subscription"."LegalChangeNoticeDelivery"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."legal_change_notice_delivery_guard"();
