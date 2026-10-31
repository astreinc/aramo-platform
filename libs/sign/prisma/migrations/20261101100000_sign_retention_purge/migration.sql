-- Aramo-Sign-Retention-and-Purge-DocuSign-Parity-Directive-v0_1-LOCKED (ebd41d99…) W1, W3, W5.
-- PO authorization 2026-10-31 (build W1-W9 + W11, purge OFF until a separate go-ahead).
--
-- ADDITIVE: four new tables, new nullable columns, new CHECKs. Two NOT NULL byte
-- columns become nullable (a purged artifact keeps its row, hashes and custody record,
-- but not its bytes). Three guard functions are replaced so each admits exactly ONE
-- new transition — the purge of an envelope whose purge is QUEUED and DUE — and keeps
-- refusing everything else:
--   sign.reject_executed_artifact_mutation   bytes to NULL plus purged_at set once
--   sign.reject_signature_event_mutation     ip_address / user_agent to NULL, and listed
--                                            payload keys to "[REDACTED]", only with a
--                                            SignatureEventRedaction row for the event
--   sign.signature_envelope_revision_bump    message to NULL at a due metadata purge
-- event_hash, previous_event_hash and every other ledger column stay immutable, so
-- historical hashes never change (LD-2). DELETE and TRUNCATE stay refused everywhere.

-- ── W1: tenant retention setting (Sign-owned, LD-1) ──────────────────────────
CREATE TABLE "sign"."SignTenantRetentionPolicy" (
    "tenant_id"      UUID NOT NULL,
    "retention_days" INTEGER,
    "purge_level"    TEXT NOT NULL DEFAULT 'DOCUMENTS',
    "updated_by"     UUID NOT NULL,
    "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignTenantRetentionPolicy_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "SignTenantRetentionPolicy_days_check" CHECK ("retention_days" IS NULL OR ("retention_days" >= 1 AND "retention_days" <= 9999)),
    CONSTRAINT "SignTenantRetentionPolicy_level_check" CHECK ("purge_level" IN ('DOCUMENTS', 'DOCUMENTS_AND_METADATA', 'DOCUMENTS_AND_METADATA_AND_REDACT'))
);

-- Every change of the setting, append-only (§3.1: actor, old value, new value).
CREATE TABLE "sign"."SignTenantRetentionPolicyEvent" (
    "id"                 UUID NOT NULL,
    "tenant_id"          UUID NOT NULL,
    "actor_user_id"      UUID NOT NULL,
    "old_retention_days" INTEGER,
    "new_retention_days" INTEGER,
    "old_purge_level"    TEXT,
    "new_purge_level"    TEXT NOT NULL,
    "changed_at"         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignTenantRetentionPolicyEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SignTenantRetentionPolicyEvent_tenant_idx" ON "sign"."SignTenantRetentionPolicyEvent" ("tenant_id", "changed_at");

CREATE OR REPLACE FUNCTION "sign".reject_retention_policy_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SignTenantRetentionPolicyEvent is append-only: UPDATE and DELETE are rejected';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER retention_policy_event_append_only
  BEFORE UPDATE OR DELETE ON "sign"."SignTenantRetentionPolicyEvent"
  FOR EACH ROW EXECUTE FUNCTION "sign".reject_retention_policy_event_mutation();

-- ── W3: envelope purge state (ADD, never reuse deleted_at) ───────────────────
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "purge_level" TEXT;
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "purge_state" TEXT;
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "purge_reason" TEXT;
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "purge_requested_by" UUID;
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "purge_queued_at" TIMESTAMPTZ;
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "purge_due_at" TIMESTAMPTZ;
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "purge_waiting_until" TIMESTAMPTZ;
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "purge_executed_at" TIMESTAMPTZ;

ALTER TABLE "sign"."SignatureEnvelope"
  ADD CONSTRAINT "SignatureEnvelope_purge_level_check"
  CHECK ("purge_level" IS NULL OR "purge_level" IN ('DOCUMENTS', 'DOCUMENTS_AND_METADATA', 'DOCUMENTS_AND_METADATA_AND_REDACT'));
ALTER TABLE "sign"."SignatureEnvelope"
  ADD CONSTRAINT "SignatureEnvelope_purge_state_check"
  CHECK ("purge_state" IS NULL OR "purge_state" IN ('QUEUED', 'DEQUEUED', 'EXECUTED'));
ALTER TABLE "sign"."SignatureEnvelope"
  ADD CONSTRAINT "SignatureEnvelope_purge_reason_check"
  CHECK ("purge_reason" IS NULL OR "purge_reason" IN ('retention', 'targeted', 'all_parties_deleted', 'account_closed', 'manual'));
-- Only completed, declined or voided envelopes are ever purged (R-7). The state, level,
-- reason and timestamps travel together, and an executed purge records when.
ALTER TABLE "sign"."SignatureEnvelope"
  ADD CONSTRAINT "SignatureEnvelope_purge_consistency_check"
  CHECK (
    ("purge_state" IS NULL) = ("purge_level" IS NULL)
    AND ("purge_state" IS NULL) = ("purge_reason" IS NULL)
    AND ("purge_state" IS NULL) = ("purge_queued_at" IS NULL)
    AND ("purge_state" IS NULL) = ("purge_due_at" IS NULL)
    AND ("purge_state" IS NULL OR "status" IN ('COMPLETED', 'DECLINED', 'VOIDED'))
    AND (("purge_state" = 'EXECUTED') = ("purge_executed_at" IS NOT NULL))
  );

CREATE INDEX "SignatureEnvelope_purge_due_idx" ON "sign"."SignatureEnvelope" ("purge_state", "purge_due_at");

-- An executed purge is final: its purge columns and the envelope status never change again.
CREATE OR REPLACE FUNCTION "sign".signature_envelope_purge_final()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.purge_state = 'EXECUTED' AND (
       NEW.purge_state IS DISTINCT FROM OLD.purge_state
    OR NEW.purge_level IS DISTINCT FROM OLD.purge_level
    OR NEW.purge_reason IS DISTINCT FROM OLD.purge_reason
    OR NEW.purge_queued_at IS DISTINCT FROM OLD.purge_queued_at
    OR NEW.purge_due_at IS DISTINCT FROM OLD.purge_due_at
    OR NEW.purge_executed_at IS DISTINCT FROM OLD.purge_executed_at
    OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'SignatureEnvelope purge is final once executed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER signature_envelope_purge_final
  BEFORE UPDATE ON "sign"."SignatureEnvelope"
  FOR EACH ROW EXECUTE FUNCTION "sign".signature_envelope_purge_final();

-- True when the envelope's purge is queued, due and not waiting: the single window in
-- which the guards below admit the purge transitions. Read with the caller's row lock.
CREATE OR REPLACE FUNCTION "sign".envelope_purge_due(p_envelope_id UUID, p_min_level TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM "sign"."SignatureEnvelope" e
     WHERE e.id = p_envelope_id
       AND e.purge_state = 'QUEUED'
       AND e.purge_due_at <= now()
       AND (e.purge_waiting_until IS NULL OR e.purge_waiting_until <= now())
       AND CASE p_min_level
             WHEN 'DOCUMENTS' THEN TRUE
             WHEN 'DOCUMENTS_AND_METADATA' THEN e.purge_level IN ('DOCUMENTS_AND_METADATA', 'DOCUMENTS_AND_METADATA_AND_REDACT')
             WHEN 'DOCUMENTS_AND_METADATA_AND_REDACT' THEN e.purge_level = 'DOCUMENTS_AND_METADATA_AND_REDACT'
             ELSE FALSE
           END
  );
$$ LANGUAGE sql STABLE;

-- The sender message stays immutable after send, except that a due metadata purge may clear it.
CREATE OR REPLACE FUNCTION "sign".signature_envelope_revision_bump()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.message IS DISTINCT FROM OLD.message AND OLD.status <> 'DRAFT'
     AND NOT (NEW.message IS NULL AND "sign".envelope_purge_due(OLD.id, 'DOCUMENTS_AND_METADATA')) THEN
    RAISE EXCEPTION 'SignatureEnvelope.message is immutable after send (M-A3 §3)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revision_txid IS DISTINCT FROM txid_current()::text THEN
    NEW.revision := OLD.revision + 1;
    NEW.revision_txid := txid_current()::text;
  ELSE
    NEW.revision := OLD.revision;
    NEW.revision_txid := OLD.revision_txid;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── W3: executed artifacts keep their row, hashes and custody; bytes are purged ──
ALTER TABLE "sign"."ExecutedDocument" ADD COLUMN "purged_at" TIMESTAMPTZ;
ALTER TABLE "sign"."ExecutedDocument" ALTER COLUMN "executed_bytes" DROP NOT NULL;
ALTER TABLE "sign"."ExecutedDocument"
  ADD CONSTRAINT "ExecutedDocument_purged_bytes_check" CHECK (("executed_bytes" IS NULL) = ("purged_at" IS NOT NULL));

ALTER TABLE "sign"."ExecutionCertificate" ADD COLUMN "purged_at" TIMESTAMPTZ;
ALTER TABLE "sign"."ExecutionCertificate" ALTER COLUMN "certificate_bytes" DROP NOT NULL;
ALTER TABLE "sign"."ExecutionCertificate"
  ADD CONSTRAINT "ExecutionCertificate_purged_bytes_check" CHECK (("certificate_bytes" IS NULL) = ("purged_at" IS NOT NULL));

-- Write-once, as SX-1, plus exactly one purge transition: purged_at NULL to a value
-- together with the bytes column to NULL, only while the envelope's purge is due.
CREATE OR REPLACE FUNCTION "sign".reject_executed_artifact_mutation()
RETURNS TRIGGER AS $$
DECLARE
  old_row JSONB;
  new_row JSONB;
  col TEXT;
  purging BOOLEAN;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION '% is write-once (SX-1): TRUNCATE is rejected', TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is write-once (SX-1): DELETE is rejected', TG_TABLE_NAME;
  END IF;
  old_row := to_jsonb(OLD);
  new_row := to_jsonb(NEW);
  purging := (old_row -> 'purged_at') IS NOT DISTINCT FROM 'null'::jsonb
         AND (new_row -> 'purged_at') IS DISTINCT FROM 'null'::jsonb
         AND "sign".envelope_purge_due(NEW.envelope_id, 'DOCUMENTS');
  FOR col IN SELECT k FROM jsonb_object_keys(old_row) AS o(k) UNION SELECT k FROM jsonb_object_keys(new_row) AS n(k) LOOP
    IF (old_row -> col) IS DISTINCT FROM (new_row -> col) THEN
      IF col = 'purged_at' THEN
        IF NOT purging THEN
          RAISE EXCEPTION '% is write-once (SX-1): purged_at is set only by a due purge', TG_TABLE_NAME;
        END IF;
      ELSIF col IN ('executed_bytes', 'certificate_bytes') THEN
        IF NOT (purging AND jsonb_typeof(new_row -> col) = 'null') THEN
          RAISE EXCEPTION '% is write-once (SX-1): column % cannot be changed', TG_TABLE_NAME, col;
        END IF;
      ELSIF col = 'written_back_at' OR left(col, 8) = 'custody_' THEN
        IF (old_row -> col) IS NOT NULL AND jsonb_typeof(old_row -> col) <> 'null' THEN
          RAISE EXCEPTION '% is write-once (SX-1): set-once column % is already set', TG_TABLE_NAME, col;
        END IF;
      ELSE
        RAISE EXCEPTION '% is write-once (SX-1): column % cannot be changed', TG_TABLE_NAME, col;
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── W3 / LD-2: ledger redaction record ───────────────────────────────────────
-- One row per redacted event, written before the event is changed: which payload keys
-- were removed, the event hash and the SHA-256 of the original payload, and whether the
-- event's hash recomputed correctly from the unredacted row at that moment. The event
-- row keeps event_hash and previous_event_hash unchanged, so the chain still links. A
-- redacted event's hash can no longer be recomputed (its input is gone by design), so
-- the chain verifier reports it REDACTED_ATTESTED, never VERIFIED: link intact, stored
-- hash equal to original_event_hash, and verified_before_redaction true.
CREATE TABLE "sign"."SignatureEventRedaction" (
    "event_id"                 UUID NOT NULL,
    "tenant_id"                UUID NOT NULL,
    "envelope_id"              UUID NOT NULL,
    "redacted_at"              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redacted_fields"          TEXT[] NOT NULL,
    "original_event_hash"      TEXT NOT NULL,
    "original_payload_sha256"  TEXT NOT NULL,
    "verified_before_redaction" BOOLEAN NOT NULL,

    CONSTRAINT "SignatureEventRedaction_pkey" PRIMARY KEY ("event_id"),
    CONSTRAINT "SignatureEventRedaction_event_fkey" FOREIGN KEY ("event_id") REFERENCES "sign"."SignatureEvent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "SignatureEventRedaction_envelope_idx" ON "sign"."SignatureEventRedaction" ("tenant_id", "envelope_id");

CREATE OR REPLACE FUNCTION "sign".reject_signature_event_redaction_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SignatureEventRedaction is append-only: UPDATE and DELETE are rejected';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER signature_event_redaction_append_only
  BEFORE UPDATE OR DELETE ON "sign"."SignatureEventRedaction"
  FOR EACH ROW EXECUTE FUNCTION "sign".reject_signature_event_redaction_mutation();

-- SignatureEvent stays append-only. The single admitted UPDATE is a redaction of an
-- event that already has its SignatureEventRedaction row, inside a due redact purge:
-- ip_address and user_agent may become NULL, and payload keys named in the redaction
-- row may become the string "[REDACTED]" (no key added or removed). Every other column,
-- including event_hash and previous_event_hash, must stay identical. DELETE is refused.
CREATE OR REPLACE FUNCTION "sign".reject_signature_event_mutation()
RETURNS TRIGGER AS $$
DECLARE
  r RECORD;
  k TEXT;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'SignatureEvent is append-only (DOC-3): UPDATE and DELETE are rejected';
  END IF;
  SELECT * INTO r FROM "sign"."SignatureEventRedaction" WHERE event_id = OLD.id;
  IF NOT FOUND OR NOT "sign".envelope_purge_due(OLD.envelope_id, 'DOCUMENTS_AND_METADATA_AND_REDACT') THEN
    RAISE EXCEPTION 'SignatureEvent is append-only (DOC-3): UPDATE and DELETE are rejected';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.envelope_id IS DISTINCT FROM OLD.envelope_id OR NEW.signer_id IS DISTINCT FROM OLD.signer_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type OR NEW.actor_type IS DISTINCT FROM OLD.actor_type
     OR NEW.actor_ref IS DISTINCT FROM OLD.actor_ref OR NEW.previous_event_hash IS DISTINCT FROM OLD.previous_event_hash
     OR NEW.event_hash IS DISTINCT FROM OLD.event_hash OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION 'SignatureEvent redaction may change only ip_address, user_agent and listed payload keys';
  END IF;
  IF NEW.ip_address IS DISTINCT FROM OLD.ip_address AND NEW.ip_address IS NOT NULL THEN
    RAISE EXCEPTION 'SignatureEvent redaction may only clear ip_address';
  END IF;
  IF NEW.user_agent IS DISTINCT FROM OLD.user_agent AND NEW.user_agent IS NOT NULL THEN
    RAISE EXCEPTION 'SignatureEvent redaction may only clear user_agent';
  END IF;
  IF NEW.payload IS DISTINCT FROM OLD.payload THEN
    IF jsonb_typeof(OLD.payload::jsonb) <> 'object' OR jsonb_typeof(NEW.payload::jsonb) <> 'object' THEN
      RAISE EXCEPTION 'SignatureEvent redaction applies to object payloads only';
    END IF;
    IF (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(OLD.payload::jsonb) x)
       IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(NEW.payload::jsonb) x) THEN
      RAISE EXCEPTION 'SignatureEvent redaction may not add or remove payload keys';
    END IF;
    FOR k IN SELECT x FROM jsonb_object_keys(OLD.payload::jsonb) x LOOP
      IF (OLD.payload::jsonb -> k) IS DISTINCT FROM (NEW.payload::jsonb -> k) THEN
        IF NOT (k = ANY (r.redacted_fields)) OR (NEW.payload::jsonb -> k) IS DISTINCT FROM '"[REDACTED]"'::jsonb THEN
          RAISE EXCEPTION 'SignatureEvent redaction: payload key % may only become "[REDACTED]" when listed', k;
        END IF;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── W5: per-party delete (DocuSign "Deleted" folder) ─────────────────────────
-- SENDER rows are keyed by the sending tenant (one sender party per envelope, LD-5);
-- RECIPIENT rows by the Aramo user bound to the recipient. External email-only signers
-- are not parties. restored_at reopens the envelope for that party until a purge executes.
CREATE TABLE "sign"."SignEnvelopePartyDeletion" (
    "id"              UUID NOT NULL,
    "tenant_id"       UUID NOT NULL,
    "envelope_id"     UUID NOT NULL,
    "party_kind"      TEXT NOT NULL,
    "party_key"       UUID NOT NULL,
    "actor_user_id"   UUID NOT NULL,
    "deleted_at"      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restored_at"     TIMESTAMPTZ,

    CONSTRAINT "SignEnvelopePartyDeletion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SignEnvelopePartyDeletion_kind_check" CHECK ("party_kind" IN ('SENDER', 'RECIPIENT')),
    CONSTRAINT "SignEnvelopePartyDeletion_envelope_fkey" FOREIGN KEY ("envelope_id") REFERENCES "sign"."SignatureEnvelope"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "SignEnvelopePartyDeletion_party_key" ON "sign"."SignEnvelopePartyDeletion" ("envelope_id", "party_kind", "party_key");
CREATE INDEX "SignEnvelopePartyDeletion_tenant_idx" ON "sign"."SignEnvelopePartyDeletion" ("tenant_id");
