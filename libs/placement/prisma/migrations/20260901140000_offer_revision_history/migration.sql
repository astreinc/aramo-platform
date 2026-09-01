-- Offer revision history (L4-B / P2) -- GENERATED forward migration from the
-- offer generator (libs/placement/src/lib/generator/offer-sql-generator.ts) by
-- ci/scripts/generate-offer-sql.ts. DO NOT EDIT BY HAND: offer:sql:check
-- (verify-offer-sql.ts) regenerates in memory and rejects any byte drift.
--
-- offer.OfferRevision is the IMMUTABLE, append-only history of the offer terms.
-- Each terms change appends a full-snapshot revision (the Offer row keeps the
-- CURRENT snapshot for reads). NEGOTIATION records a revision rather than
-- overwriting in place. Same Talent-facing scope as the Offer snapshot: NO bill
-- rate, margin, or markup. Append-only is enforced by a trigger (mirrors
-- OfferEvent). revision_number is a monotonic 1-based counter per (tenant, offer).
-- NOTE keep this comment block free of the statement terminator and the dollar-
-- quote delimiter -- the integration migration splitter is dollar-quote aware but
-- does not strip line comments.

CREATE TABLE "offer"."OfferRevision" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "offer_id" UUID NOT NULL,
  "revision_number" INTEGER NOT NULL,
  "proposed_start_date" DATE,
  "offer_expires_at" TIMESTAMPTZ(6),
  "client_offer_reference" TEXT,
  "offer_terms_summary" TEXT,
  "compensation_type" TEXT,
  "compensation_amount" DECIMAL(12, 2),
  "compensation_currency" TEXT,
  "compensation_period" TEXT,
  "recorded_by" UUID NOT NULL,
  "change_reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "OfferRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OfferRevision_offer_fk" FOREIGN KEY ("offer_id") REFERENCES "offer"."Offer" ("id")
);

CREATE UNIQUE INDEX "OfferRevision_offer_number_uniq" ON "offer"."OfferRevision" ("tenant_id", "offer_id", "revision_number");
CREATE INDEX "OfferRevision_tenant_offer_idx" ON "offer"."OfferRevision" ("tenant_id", "offer_id");

-- OfferRevision is append-only: reject UPDATE and DELETE (mirrors OfferEvent).
CREATE OR REPLACE FUNCTION "offer".freeze_offer_revision()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'OfferRevision is append-only (no % permitted)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER freeze_offer_revision_trg
  BEFORE UPDATE OR DELETE ON "offer"."OfferRevision"
  FOR EACH ROW EXECUTE FUNCTION "offer".freeze_offer_revision();
