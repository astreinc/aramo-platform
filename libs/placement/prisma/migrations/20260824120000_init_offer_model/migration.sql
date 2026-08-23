-- Offer aggregate init migration — GENERATED from the offer lifecycle registry
-- (libs/placement/src/lib/lifecycle/offer-lifecycle.ts) by
-- ci/scripts/generate-offer-sql.ts. DO NOT EDIT BY HAND: offer:sql:check
-- (verify-offer-sql.ts) regenerates in memory and rejects any byte drift.
--
-- The Offer is the dedicated pre-placement offer state machine (Option B):
-- DRAFT -> SENT -> NEGOTIATION -> ACCEPTED / DECLINED / EXPIRED / RESCINDED.
-- An ACCEPTED offer is the precondition for a placement (the D6 re-point).
-- NOTE keep this comment block free of the statement terminator and the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments.

CREATE SCHEMA IF NOT EXISTS "offer";

CREATE TYPE "offer"."OfferState" AS ENUM ('DRAFT', 'SENT', 'NEGOTIATION', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'RESCINDED');
CREATE TYPE "offer"."OfferEventType" AS ENUM ('state_transition');

CREATE TABLE "offer"."Offer" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "submittal_id" UUID NOT NULL,
  "requisition_id" UUID NOT NULL,
  "talent_record_id" UUID NOT NULL,
  "state" "offer"."OfferState" NOT NULL,
  "proposed_start_date" DATE,
  "offer_expires_at" TIMESTAMPTZ(6),
  "client_offer_reference" TEXT,
  "offer_terms_summary" TEXT,
  "decline_reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Offer_tenant_submittal_idx" ON "offer"."Offer" ("tenant_id", "submittal_id");
CREATE INDEX "Offer_tenant_requisition_idx" ON "offer"."Offer" ("tenant_id", "requisition_id");
CREATE INDEX "Offer_tenant_talent_idx" ON "offer"."Offer" ("tenant_id", "talent_record_id");

CREATE TABLE "offer"."OfferEvent" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "offer_id" UUID NOT NULL,
  "event_type" "offer"."OfferEventType" NOT NULL,
  "event_payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "OfferEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OfferEvent_offer_fk" FOREIGN KEY ("offer_id") REFERENCES "offer"."Offer" ("id")
);

CREATE INDEX "OfferEvent_tenant_offer_idx" ON "offer"."OfferEvent" ("tenant_id", "offer_id");
CREATE INDEX "OfferEvent_offer_created_idx" ON "offer"."OfferEvent" ("offer_id", "created_at");

CREATE TABLE "offer"."OutboxEvent" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "event_type" TEXT NOT NULL,
  "event_payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "published_at" TIMESTAMPTZ(6),
  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OfferOutbox_published_idx" ON "offer"."OutboxEvent" ("published_at");

-- ============================================================================
-- Offer lifecycle guard (generated from the registry):
-- A. BEFORE INSERT -- at most one NON-terminal offer per (tenant_id, submittal_id).
-- B. BEFORE UPDATE -- only the state column moves, and only along a legal edge
--    where every identity/lineage column is pinned byte-identical.
-- ============================================================================
CREATE OR REPLACE FUNCTION "offer".enforce_offer_lifecycle()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    IF EXISTS (
      SELECT 1 FROM "offer"."Offer" existing
      WHERE existing.tenant_id = NEW.tenant_id
        AND existing.submittal_id = NEW.submittal_id
        AND existing.state NOT IN ('ACCEPTED', 'DECLINED', 'EXPIRED', 'RESCINDED')
    ) THEN
      RAISE EXCEPTION
        'Offer permits at most one live offer per (tenant_id, submittal_id) -- a non-terminal offer already exists for this pair'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (TG_OP = 'UPDATE') THEN
  IF (OLD.state = 'DRAFT' AND NEW.state = 'SENT'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'DRAFT' AND NEW.state = 'RESCINDED'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'SENT' AND NEW.state = 'NEGOTIATION'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'SENT' AND NEW.state = 'ACCEPTED'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'SENT' AND NEW.state = 'DECLINED'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'SENT' AND NEW.state = 'EXPIRED'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'SENT' AND NEW.state = 'RESCINDED'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'NEGOTIATION' AND NEW.state = 'SENT'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'NEGOTIATION' AND NEW.state = 'ACCEPTED'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'NEGOTIATION' AND NEW.state = 'DECLINED'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'NEGOTIATION' AND NEW.state = 'EXPIRED'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.state = 'NEGOTIATION' AND NEW.state = 'RESCINDED'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.submittal_id = NEW.submittal_id
      AND OLD.requisition_id = NEW.requisition_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.created_at = NEW.created_at)
  THEN
    RETURN NEW;
  END IF;

    RAISE EXCEPTION
      'Offer illegal transition or immutable-column violation: % -> %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_offer_lifecycle_trg
  BEFORE INSERT OR UPDATE ON "offer"."Offer"
  FOR EACH ROW EXECUTE FUNCTION "offer".enforce_offer_lifecycle();

-- OfferEvent is append-only: reject UPDATE and DELETE.
CREATE OR REPLACE FUNCTION "offer".freeze_offer_event()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'OfferEvent is append-only (no % permitted)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER freeze_offer_event_trg
  BEFORE UPDATE OR DELETE ON "offer"."OfferEvent"
  FOR EACH ROW EXECUTE FUNCTION "offer".freeze_offer_event();

-- OutboxEvent is append-only except published_at (drain stamp): reject DELETE and
-- any UPDATE that changes a column other than published_at.
CREATE OR REPLACE FUNCTION "offer".freeze_offer_outbox()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    RAISE EXCEPTION 'OutboxEvent is append-only (no DELETE permitted)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.id IS DISTINCT FROM NEW.id
      OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
      OR OLD.event_type IS DISTINCT FROM NEW.event_type
      OR OLD.event_payload IS DISTINCT FROM NEW.event_payload
      OR OLD.created_at IS DISTINCT FROM NEW.created_at) THEN
    RAISE EXCEPTION 'OutboxEvent is append-only (only published_at may change)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER freeze_offer_outbox_trg
  BEFORE UPDATE OR DELETE ON "offer"."OutboxEvent"
  FOR EACH ROW EXECUTE FUNCTION "offer".freeze_offer_outbox();
-- non-terminal states (one-live guard scope): DRAFT, SENT, NEGOTIATION
