-- SIGN-FREE-PARITY-1 S3 — an email one-time code for signers (all plans; sign.email_otp).
-- ADD only. The sender asks for a code sent to the recipient's email before signing; the
-- code rules are the SMS code's (6 digits, 10 minutes, 5 attempts, resend gap, daily sends,
-- lockout). Only the SHA-256 of the code is kept, in the same challenge table as the SMS
-- code, told apart by "method".

-- The sender's choice, per recipient. Link recipients only (SIGNER, WITNESS), who always
-- have an email. A recipient may require both an SMS and an email code: both must be
-- verified in the same signing session.
ALTER TABLE "sign"."Signer" ADD COLUMN "email_otp_required" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sign"."Signer"
  ADD CONSTRAINT "Signer_email_otp_check" CHECK (
    "email_otp_required" = false OR ("recipient_kind" IN ('SIGNER', 'WITNESS') AND "email" IS NOT NULL)
  );

-- Which code a challenge is: existing rows are SMS codes. email_masked is set for an email
-- code (j***@example.com), never the address itself.
ALTER TABLE "sign"."SignRecipientOtpChallenge" ADD COLUMN "method" TEXT NOT NULL DEFAULT 'SMS_OTP';
ALTER TABLE "sign"."SignRecipientOtpChallenge" ADD COLUMN "email_masked" TEXT;
ALTER TABLE "sign"."SignRecipientOtpChallenge"
  ADD CONSTRAINT "SignRecipientOtpChallenge_method_check" CHECK ("method" IN ('SMS_OTP', 'EMAIL_OTP'));
