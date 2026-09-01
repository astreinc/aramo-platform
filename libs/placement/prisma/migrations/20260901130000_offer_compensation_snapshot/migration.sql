-- Offer compensation snapshot (L4-A / P1) -- GENERATED forward migration from the
-- offer generator (libs/placement/src/lib/generator/offer-sql-generator.ts) by
-- ci/scripts/generate-offer-sql.ts. DO NOT EDIT BY HAND: offer:sql:check
-- (verify-offer-sql.ts) regenerates in memory and rejects any byte drift.
--
-- Adds the structured Talent-facing compensation snapshot to offer.Offer: the
-- pay/salary terms presented to the talent. Strictly NO bill rate, margin,
-- markup, or internal financial planning -- those are Track-5 commercial terms on
-- ContractAssignment, never the offer. compensation_type discriminates CONTRACT
-- (a sub-annual pay rate) vs PERMANENT (an ANNUAL base salary). amount is
-- Decimal(12,2) (never float) -- currency (ISO-4217) and period (rate-period)
-- validate against the libs/common shared closed sets at the write boundary.
-- Nullable at the DB and NOT pinned by the lifecycle trigger (identity/lineage
-- only) -- app-surface immutable, with terms changes captured as OfferRevision.
-- NOTE keep this comment block free of the statement terminator and the dollar-
-- quote delimiter -- the integration migration splitter is dollar-quote aware but
-- does not strip line comments.

ALTER TABLE "offer"."Offer" ADD COLUMN "compensation_type" TEXT;
ALTER TABLE "offer"."Offer" ADD COLUMN "compensation_amount" DECIMAL(12, 2);
ALTER TABLE "offer"."Offer" ADD COLUMN "compensation_currency" TEXT;
ALTER TABLE "offer"."Offer" ADD COLUMN "compensation_period" TEXT;
