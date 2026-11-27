-- SIGN-FREE-PARITY-1 S2 (FP-R2) — a flagged Personal sender clears the young-account
-- phone step-up themselves with an SMS code. Additive on TenantRiskState
-- (20261022120000_sign_personal_free created it; that migration is merged and immutable).
-- Only the SHA-256 of the code is stored (personal-otp.ts: 6 digits, 10 minutes,
-- 5 attempts, 60 s resend gap, 5 sends a day). phone_verified_at is still set ONLY by a
-- successful code check. No returned shape changes (the risk-state views pick their fields).

ALTER TABLE "identity"."TenantRiskState" ADD COLUMN "step_up_code_hash" TEXT;
ALTER TABLE "identity"."TenantRiskState" ADD COLUMN "step_up_code_phone_e164" TEXT;
ALTER TABLE "identity"."TenantRiskState" ADD COLUMN "step_up_code_expires_at" TIMESTAMPTZ(6);
ALTER TABLE "identity"."TenantRiskState" ADD COLUMN "step_up_code_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "identity"."TenantRiskState" ADD COLUMN "step_up_code_last_sent_at" TIMESTAMPTZ(6);
-- The 24-hour send window: when it started and how many codes were sent in it.
ALTER TABLE "identity"."TenantRiskState" ADD COLUMN "step_up_code_window_start" TIMESTAMPTZ(6);
ALTER TABLE "identity"."TenantRiskState" ADD COLUMN "step_up_code_sends" INTEGER NOT NULL DEFAULT 0;
