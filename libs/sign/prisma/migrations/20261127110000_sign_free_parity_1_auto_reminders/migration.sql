-- SIGN-FREE-PARITY-1 S4 — automatic reminders (FP-R5).
-- Governing: Aramo-Sign-Free-Parity-1-Directive-v1_0-LOCKED §S4.
-- Additive only: four new columns with defaults (no rewrite of existing rows' meaning), two
-- CHECKs and one partial index. No trigger: the setting is writable before AND after send
-- (unlike allow_delegation), and the envelope revision trigger bumps the revision on every
-- write as usual.
--
-- auto_reminders_enabled — the sender's per-envelope switch (default ON; the sender can turn
--   it off while drafting or after sending).
-- auto_reminder_count    — automatic reminders sent so far (0..5; the cadence max is 5).
-- next_auto_reminder_at  — when the worker sends the next one; NULL = none planned. Set at
--   send (sent_at + 2 days) by the Sign console send path only, so envelopes sent before this
--   migration, and envelopes sent by other applications, never get automatic reminders.
-- send_risk_verdict      — the verdict of the send-time check, recorded at send. A system
--   reminder has no IP: it reuses this verdict and is never re-checked against the Personal
--   young-account rule. ALLOWED = a Personal send that passed the check; NOT_GATED = a
--   Business send (Business accounts are not risk-checked). NULL = not recorded (never
--   reminded automatically).

ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "auto_reminders_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "auto_reminder_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "next_auto_reminder_at" TIMESTAMPTZ;
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "send_risk_verdict" TEXT;

ALTER TABLE "sign"."SignatureEnvelope"
  ADD CONSTRAINT "SignatureEnvelope_auto_reminder_count_check" CHECK ("auto_reminder_count" BETWEEN 0 AND 5);
ALTER TABLE "sign"."SignatureEnvelope"
  ADD CONSTRAINT "SignatureEnvelope_send_risk_verdict_check" CHECK ("send_risk_verdict" IS NULL OR "send_risk_verdict" IN ('ALLOWED', 'NOT_GATED'));

-- The worker's due query: open envelopes with a planned automatic reminder.
CREATE INDEX "SignatureEnvelope_auto_reminder_due_idx" ON "sign"."SignatureEnvelope" ("next_auto_reminder_at")
  WHERE "next_auto_reminder_at" IS NOT NULL AND "status" IN ('SENT', 'IN_PROGRESS');
