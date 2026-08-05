-- Track 3 / E1-c — initial offer snapshot on PlacementProcess + the placement
-- OutboxEvent namespace. ADDITIVE ONLY: the generated init migration and the
-- lifecycle registry are NOT touched (placement:sql:check stays byte-equal).
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments.

-- AlterTable — the initial offer snapshot (9-c-1). offered_at is required -- the
-- transient DEFAULT backfills any existing rows and is then dropped (the app
-- always sets offered_at explicitly).
ALTER TABLE "placement"."PlacementProcess"
  ADD COLUMN "offered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "proposed_start_date" DATE,
  ADD COLUMN "offer_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "client_offer_reference" TEXT,
  ADD COLUMN "offer_terms_summary" TEXT;

ALTER TABLE "placement"."PlacementProcess" ALTER COLUMN "offered_at" DROP DEFAULT;

-- offer_expires_at, when present, must not precede offered_at (9-c-1 invariant).
ALTER TABLE "placement"."PlacementProcess"
  ADD CONSTRAINT "PlacementProcess_offer_expiry_after_offered_chk"
  CHECK ("offer_expires_at" IS NULL OR "offer_expires_at" >= "offered_at");

-- CreateTable — the placement outbox namespace (9-c-2), house six-column shape.
CREATE TABLE "placement"."OutboxEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxEvent_published_at_idx" ON "placement"."OutboxEvent"("published_at");

-- Column-scoped immutability (9-c-2 / proof 9). The event is append-only: DELETE
-- is rejected, and UPDATE is rejected for every column EXCEPT published_at (the
-- publisher stamps published_at on drain). Stricter than the trigger-less house
-- convention so the append-only contract is assertable.
CREATE OR REPLACE FUNCTION placement.reject_outbox_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'placement.OutboxEvent is append-only -- DELETE is not permitted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."event_type" IS DISTINCT FROM OLD."event_type"
     OR NEW."event_payload" IS DISTINCT FROM OLD."event_payload"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'placement.OutboxEvent is append-only -- only published_at may be updated'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_outbox_update
  BEFORE UPDATE ON "placement"."OutboxEvent"
  FOR EACH ROW EXECUTE FUNCTION placement.reject_outbox_mutation();

CREATE TRIGGER trg_reject_outbox_delete
  BEFORE DELETE ON "placement"."OutboxEvent"
  FOR EACH ROW EXECUTE FUNCTION placement.reject_outbox_mutation();
