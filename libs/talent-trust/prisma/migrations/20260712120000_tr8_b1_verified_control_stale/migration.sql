-- TR-8 D2 (DDR) — verified_control_stale flag on TrustState
--
-- TRUE when the subject has a current (VALID, non-superseded) platform-verification
-- act older than VERIFICATION_STALE_DAYS (365) Derived at recompute the T5-B1 daily
-- sweep flips it with zero writes when the threshold passes (SLOW evidence keeps the
-- subject sweep-selected) Re-verification (D1) mints a fresh act and clears it
-- Additive-only, NOT NULL with a false default so existing rows read false until
-- their next recompute Surfaced only as an assessment statement, never a number

ALTER TABLE "talent_trust"."TrustState"
    ADD COLUMN "verified_control_stale" BOOLEAN NOT NULL DEFAULT false;
