-- Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED §6.4 / §7 — abuse reports
-- ("Report this email") on signing emails from Personal senders.
-- Additive only: one new table. splitDdl-safe: no semicolons in comment lines.
--
-- One report per recipient per envelope, only from the recipient's own signing
-- link. Each report keeps the factors of its weight (severity, independence,
-- credibility) so every automatic decision is explainable. The reporter is held
-- as a one-way digest of the recipient address (credibility across reports) plus
-- the address domain (independence), never the address itself.
-- An operator outcome FALSE_REPORT lowers that reporter's future credibility.
CREATE TABLE "sign"."AbuseReport" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "envelope_id" UUID NOT NULL,
    "signer_id" UUID NOT NULL,
    "reason" TEXT,
    "note" TEXT,
    "reporter_key" TEXT NOT NULL,
    "reporter_domain" TEXT NOT NULL,
    "severity" DOUBLE PRECISION NOT NULL,
    "independence" DOUBLE PRECISION NOT NULL,
    "credibility" DOUBLE PRECISION NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "triggered_restriction" BOOLEAN NOT NULL DEFAULT false,
    "outcome" TEXT NOT NULL DEFAULT 'OPEN',
    "outcome_reason" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AbuseReport_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AbuseReport_envelope_id_fkey" FOREIGN KEY ("envelope_id") REFERENCES "sign"."SignatureEnvelope"("id") ON DELETE CASCADE,
    CONSTRAINT "AbuseReport_signer_id_fkey" FOREIGN KEY ("signer_id") REFERENCES "sign"."Signer"("id") ON DELETE CASCADE,
    CONSTRAINT "AbuseReport_reason_check" CHECK ("reason" IS NULL OR "reason" IN ('phishing', 'impersonation', 'spam', 'unknown_sender', 'other')),
    CONSTRAINT "AbuseReport_note_check" CHECK ("note" IS NULL OR char_length("note") <= 1000),
    CONSTRAINT "AbuseReport_outcome_check" CHECK ("outcome" IN ('OPEN', 'CONFIRMED', 'FALSE_REPORT', 'DISMISSED')),
    CONSTRAINT "AbuseReport_weight_check" CHECK ("severity" >= 0 AND "independence" >= 0 AND "credibility" >= 0 AND "weight" >= 0)
);
-- One report per recipient per envelope.
CREATE UNIQUE INDEX "AbuseReport_envelope_id_signer_id_key" ON "sign"."AbuseReport"("envelope_id", "signer_id");
CREATE INDEX "AbuseReport_tenant_id_created_at_idx" ON "sign"."AbuseReport"("tenant_id", "created_at");
CREATE INDEX "AbuseReport_reporter_key_idx" ON "sign"."AbuseReport"("reporter_key");
