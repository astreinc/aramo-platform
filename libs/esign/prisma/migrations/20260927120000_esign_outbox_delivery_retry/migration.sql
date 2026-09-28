-- E-Sign Operational Closure v2 (DEC-A) — durable outbound-delivery retry state
-- on the E-Sign transactional outbox. E-Sign owns reliable lifecycle-event
-- delivery (Independent-Digital-Signature-Platform Directive sections 8 and 28),
-- so the outbox must persist attempt bookkeeping and a backoff schedule rather
-- than a blind fixed-interval retry. Additive only.
--   attempt_count   how many delivery attempts have been made
--   next_attempt_at when the delivery worker may next claim this row (NULL = due now)
--   last_attempt_at when the last delivery attempt ran
--   last_error_code bounded, sanitized short diagnostic (never a raw response body)
ALTER TABLE "esign"."OutboxEvent"
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "next_attempt_at" TIMESTAMPTZ,
  ADD COLUMN "last_attempt_at" TIMESTAMPTZ,
  ADD COLUMN "last_error_code" VARCHAR(64);

-- Claim-query support — due, unpublished rows in creation order. The delivery
-- worker selects WHERE published_at IS NULL AND (next_attempt_at IS NULL OR
-- next_attempt_at <= now()).
CREATE INDEX "OutboxEvent_published_at_next_attempt_at_idx"
  ON "esign"."OutboxEvent" ("published_at", "next_attempt_at");
