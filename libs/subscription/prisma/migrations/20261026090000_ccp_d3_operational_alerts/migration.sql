-- CCP-D3 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED section 5.4 row D3) operational alerts:
-- the operator-visible exception register for billing and approval operations.
--
-- ADDITIVE ONLY. No existing table, column, index, function or row changes.
--   CommercialOperationalAlert  one row per detected condition on one subject. At most ONE OPEN row
--                               per (alert_type, subject_id) (partial unique index). OPEN -> RESOLVED
--                               only, RESOLVED terminal, identity columns immutable, DELETE rejected
--                               (trigger). Written only by the alert scanner, which reads the source
--                               tables and never changes them.
-- No money, no per-tenant grade or ordering: the row names a subject and its observed state.
--
-- Carries dollar-quoted trigger bodies: any spec applying this migration MUST use a whole-file DDL
-- applier (pg Client), never a line splitter.
--
-- Compensating migration (documented, not shipped; doc/ccp/slices/CCP-D3-acceptance.md): drop the
-- trigger, the table and the function. The rows are derived observations (recomputable by a scan).
-- Design approval is not production migration authority (ruling A0-C15).

CREATE TABLE "subscription"."CommercialOperationalAlert" (
    "id" UUID NOT NULL,
    "alert_type" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "product_key" TEXT,
    "status" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "threshold_minutes" INTEGER,
    "detection_count" INTEGER NOT NULL,
    "first_detected_at" TIMESTAMPTZ(3) NOT NULL,
    "last_detected_at" TIMESTAMPTZ(3) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution_detail" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CommercialOperationalAlert_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommercialOperationalAlert_type_check" CHECK (
        ("alert_type" = 'COMMAND_PENDING_PROVIDER_STUCK' AND "family" = 'BILLING' AND "subject_kind" = 'billing_command')
     OR ("alert_type" = 'COMMAND_FAILED' AND "family" = 'BILLING' AND "subject_kind" = 'billing_command')
     OR ("alert_type" = 'HELD_ACTIVATION' AND "family" = 'BILLING' AND "subject_kind" = 'reconciliation_flag')
     OR ("alert_type" = 'WEBHOOK_INBOX_FAILED' AND "family" = 'BILLING' AND "subject_kind" = 'webhook_inbox')
     OR ("alert_type" = 'USAGE_NOT_RECONCILED' AND "family" = 'BILLING' AND "subject_kind" = 'usage_metric')
     OR ("alert_type" = 'APPLY_FAILED' AND "family" = 'APPROVAL' AND "subject_kind" = 'change_request')
     OR ("alert_type" = 'APPROVAL_NEARING_EXPIRY' AND "family" = 'APPROVAL' AND "subject_kind" = 'change_request')
     OR ("alert_type" = 'APPROVAL_PAST_EXPIRY' AND "family" = 'APPROVAL' AND "subject_kind" = 'change_request')),
    CONSTRAINT "CommercialOperationalAlert_subject_id_check" CHECK (length("subject_id") BETWEEN 1 AND 255),
    CONSTRAINT "CommercialOperationalAlert_product_key_registry_check" CHECK ("product_key" IS NULL OR "product_key" IN ('sign')),
    CONSTRAINT "CommercialOperationalAlert_status_check" CHECK ("status" IN ('OPEN', 'RESOLVED')),
    CONSTRAINT "CommercialOperationalAlert_resolved_check" CHECK (
        ("status" = 'RESOLVED') = ("resolved_at" IS NOT NULL)
        AND ("resolved_at" IS NULL) = ("resolution_detail" IS NULL)),
    CONSTRAINT "CommercialOperationalAlert_evidence_check" CHECK (jsonb_typeof("evidence") = 'object'),
    CONSTRAINT "CommercialOperationalAlert_threshold_check" CHECK ("threshold_minutes" IS NULL OR "threshold_minutes" > 0),
    CONSTRAINT "CommercialOperationalAlert_detection_check" CHECK (
        "detection_count" >= 1 AND "last_detected_at" >= "first_detected_at"
        AND ("resolved_at" IS NULL OR "resolved_at" >= "first_detected_at"))
);

CREATE UNIQUE INDEX "CommercialOperationalAlert_one_open_key" ON "subscription"."CommercialOperationalAlert"("alert_type", "subject_id") WHERE "status" = 'OPEN';
CREATE INDEX "CommercialOperationalAlert_family_status_idx" ON "subscription"."CommercialOperationalAlert"("family", "status", "first_detected_at" DESC, "id" DESC);
CREATE INDEX "CommercialOperationalAlert_family_first_detected_idx" ON "subscription"."CommercialOperationalAlert"("family", "first_detected_at" DESC, "id" DESC);
CREATE INDEX "CommercialOperationalAlert_subject_idx" ON "subscription"."CommercialOperationalAlert"("subject_kind", "subject_id");

CREATE FUNCTION "subscription"."guard_commercial_operational_alert"()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'CommercialOperationalAlert rows are never deleted (the exception register keeps its history)';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'OPEN' OR NEW."detection_count" <> 1 OR NEW."last_detected_at" <> NEW."first_detected_at" THEN
            RAISE EXCEPTION 'CommercialOperationalAlert starts OPEN with one detection (got % / %)', NEW."status", NEW."detection_count";
        END IF;
        RETURN NEW;
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."alert_type" IS DISTINCT FROM OLD."alert_type"
       OR NEW."family" IS DISTINCT FROM OLD."family"
       OR NEW."subject_kind" IS DISTINCT FROM OLD."subject_kind"
       OR NEW."subject_id" IS DISTINCT FROM OLD."subject_id"
       OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."product_key" IS DISTINCT FROM OLD."product_key"
       OR NEW."first_detected_at" IS DISTINCT FROM OLD."first_detected_at" THEN
        RAISE EXCEPTION 'CommercialOperationalAlert identity columns are immutable';
    END IF;
    IF OLD."status" = 'RESOLVED' THEN
        RAISE EXCEPTION 'CommercialOperationalAlert % is RESOLVED (terminal)', OLD."id";
    END IF;
    IF NEW."detection_count" < OLD."detection_count" OR NEW."last_detected_at" < OLD."last_detected_at" THEN
        RAISE EXCEPTION 'CommercialOperationalAlert detections never go backwards (% -> %)', OLD."detection_count", NEW."detection_count";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "commercial_operational_alert_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "subscription"."CommercialOperationalAlert"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_commercial_operational_alert"();
