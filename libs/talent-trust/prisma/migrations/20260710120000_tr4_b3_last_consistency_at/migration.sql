-- TR-4 B3 (§3.1) — the consistency-poll watermark on ResolutionSubject
--
-- The hourly detector poll re-selects an ACTIVE subject when it has gained CLAIMS
-- evidence since this stamp (NULL = never checked) the poll sets it LAST on a
-- per-subject run so a transient failure leaves it un-advanced Independent of
-- last_matched_at (the match-sweep watermark) additive-only, nullable, no default

ALTER TABLE "talent_trust"."ResolutionSubject"
    ADD COLUMN "last_consistency_at" TIMESTAMPTZ;
