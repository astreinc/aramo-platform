-- SW-2 (Submittal Workspace, R2-A + R4-A/R4-B) — canonical `submitted_to_client`
-- state + immutable V1 submittal provenance on TalentSubmittalRecord.
--
-- 1. Rename the canonical send state IN PLACE: submitted_to_ats -> submitted_to_client
--    (enum-value rename. the state column + all stored rows migrate automatically).
--    Historical migration files are NOT rewritten. this forward migration carries it.
-- 2. Backfill the denormalized JSONB event/outbox payloads (from_state/to_state) so
--    the submitted-history grain reader stays single-valued and historically
--    continuous. The append-only event trigger is disabled ONLY for this controlled
--    canonical-rename backfill, then restored.
-- 3. Add the delivery-channel enum (what ACTUALLY happened for THIS submittal — a
--    distinct axis from the requisition-grain SubmittalAuthority EXPECTATION).
--    aramo_connector exists for forward-compat only. V1 has no outbound connector
--    (the submit command refuses it).
-- 4. Add the immutable V1 submittal-provenance columns (who/when/how + frozen
--    client-facing rate + external reference/timestamp), all nullable pre-send.
-- 5. Rewrite the enumerated-allowlist immutability trigger: rename the send state in
--    every branch, authorize the ONE-TIME set of the new provenance columns at the
--    send transition (OLD IS NULL), and freeze them (IS NOT DISTINCT FROM) elsewhere.
--
-- NOTE keep every line comment free of the statement terminator and the dollar-quote
-- delimiter -- the integration splitter is dollar-quote aware but does not strip line comments.

-- 1 — enum-value rename (in place. PG12+ permits RENAME VALUE inside a tx). GUARDED
-- on label existence: a full deployment always has 'submitted_to_ats' (created by the
-- 20260527 rename migration) so the rename runs. curated test-migration subsets that
-- omit that prerequisite simply skip the rename (same philosophy as the to_regclass
-- table guards below). The DO block uses the splitter-recognized dollar-quote delimiter.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
      JOIN pg_type t ON e.enumtypid = t.oid
      JOIN pg_namespace n ON t.typnamespace = n.oid
     WHERE n.nspname = 'submittal' AND t.typname = 'SubmittalState'
       AND e.enumlabel = 'submitted_to_ats'
  ) THEN
    EXECUTE 'ALTER TYPE "submittal"."SubmittalState" RENAME VALUE ''submitted_to_ats'' TO ''submitted_to_client''';
  END IF;
END
$$;

-- 2 — backfill the denormalized JSONB state tokens (append-only trigger disabled for
-- this controlled canonical rename, then restored). The business fact is unchanged.
-- only the vocabulary token is renamed, matching the enum-value rename above.
-- Event-payload backfill is GUARDED (same rationale as OutboxEvent below): a curated
-- test subset may have TalentSubmittalRecord without the TalentSubmittalEvent table.
-- The append-only trigger is disabled ONLY for this controlled canonical rename.
DO $$
BEGIN
  IF to_regclass('submittal."TalentSubmittalEvent"') IS NOT NULL THEN
    ALTER TABLE "submittal"."TalentSubmittalEvent" DISABLE TRIGGER "trg_reject_submittal_event_update";
    UPDATE "submittal"."TalentSubmittalEvent"
       SET event_payload = jsonb_set(event_payload, '{to_state}', '"submitted_to_client"')
     WHERE event_payload->>'to_state' = 'submitted_to_ats';
    UPDATE "submittal"."TalentSubmittalEvent"
       SET event_payload = jsonb_set(event_payload, '{from_state}', '"submitted_to_client"')
     WHERE event_payload->>'from_state' = 'submitted_to_ats';
    ALTER TABLE "submittal"."TalentSubmittalEvent" ENABLE TRIGGER "trg_reject_submittal_event_update";
  END IF;
END
$$;

-- OutboxEvent payload backfill is GUARDED. A migration must not assume a sibling
-- table exists -- curated test-migration subsets may omit the submittal OutboxEvent
-- table. In a full deployment the table is present and the backfill runs. The DO
-- block uses the splitter-recognized dollar-quote delimiter (named delimiters are not split-safe).
DO $$
BEGIN
  IF to_regclass('submittal."OutboxEvent"') IS NOT NULL THEN
    UPDATE "submittal"."OutboxEvent"
       SET event_payload = jsonb_set(event_payload, '{to_state}', '"submitted_to_client"')
     WHERE event_payload->>'to_state' = 'submitted_to_ats';
    UPDATE "submittal"."OutboxEvent"
       SET event_payload = jsonb_set(event_payload, '{from_state}', '"submitted_to_client"')
     WHERE event_payload->>'from_state' = 'submitted_to_ats';
  END IF;
END
$$;

-- 3 — delivery-channel enum (ACTUAL provenance. distinct from SubmittalAuthority).
CREATE TYPE "submittal"."SubmittalDeliveryChannel" AS ENUM (
  'manual_vms',
  'manual_client_portal',
  'manual_email',
  'manual_other',
  'aramo_connector'
);

-- 4 — immutable V1 submittal-provenance columns. All nullable pre-send. pinned ONCE
-- at the send transition. frozen thereafter by the rewritten trigger (step 5).
ALTER TABLE "submittal"."TalentSubmittalRecord"
  ADD COLUMN "submitted_at"            TIMESTAMPTZ,
  ADD COLUMN "submitted_by_actor_id"   UUID,
  ADD COLUMN "delivery_channel"        "submittal"."SubmittalDeliveryChannel",
  ADD COLUMN "submitted_bill_rate"     DECIMAL(12,2),
  ADD COLUMN "submitted_rate_currency" TEXT,
  ADD COLUMN "submitted_rate_period"   TEXT,
  ADD COLUMN "external_reference"      TEXT,
  ADD COLUMN "external_submitted_at"   TIMESTAMPTZ;

-- 5 — rewrite the enumerated-allowlist immutability trigger (relocated to the
-- submittal schema by 20260812120000_t2p1. trg_reject_submittal_record_update keeps
-- pointing at this function). Renames the send state to submitted_to_client in every
-- branch. authorizes the one-time set of the provenance columns at the send. freezes
-- them everywhere else. pipeline_id + resume_edition_id discipline preserved verbatim.
CREATE OR REPLACE FUNCTION submittal.reject_submittal_record_update()
RETURNS TRIGGER AS $$
DECLARE
  is_reconcile boolean := coalesce(current_setting('app.reconcile', true), 'off') = 'on';
BEGIN
  -- Reconcile re-key (TR-2a-B3b) -- a talent_id-only diff under the app.reconcile GUC.
  IF is_reconcile AND (to_jsonb(NEW) - 'talent_id') = (to_jsonb(OLD) - 'talent_id') THEN
    RETURN NEW;
  END IF;

  -- Transition 1 -- created to handoff_draft. All business/provenance fields frozen.
  IF (OLD.state = 'created' AND NEW.state = 'handoff_draft'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.talent_id = NEW.talent_id
      AND OLD.job_id = NEW.job_id
      AND OLD.evidence_package_id = NEW.evidence_package_id
      AND OLD.pinned_examination_id = NEW.pinned_examination_id
      AND OLD.created_by = NEW.created_by
      AND OLD.created_at = NEW.created_at
      AND OLD.pipeline_id IS NOT DISTINCT FROM NEW.pipeline_id
      AND OLD.resume_edition_id IS NOT DISTINCT FROM NEW.resume_edition_id
      AND OLD.justification IS NOT DISTINCT FROM NEW.justification
      AND OLD.failed_criterion_acknowledgments IS NOT DISTINCT FROM NEW.failed_criterion_acknowledgments
      AND OLD.confirmed_at IS NOT DISTINCT FROM NEW.confirmed_at
      AND OLD.revoked_at IS NOT DISTINCT FROM NEW.revoked_at
      AND OLD.revoked_by IS NOT DISTINCT FROM NEW.revoked_by
      AND OLD.revocation_justification IS NOT DISTINCT FROM NEW.revocation_justification
      AND OLD.submitted_at IS NOT DISTINCT FROM NEW.submitted_at
      AND OLD.submitted_by_actor_id IS NOT DISTINCT FROM NEW.submitted_by_actor_id
      AND OLD.delivery_channel IS NOT DISTINCT FROM NEW.delivery_channel
      AND OLD.submitted_bill_rate IS NOT DISTINCT FROM NEW.submitted_bill_rate
      AND OLD.submitted_rate_currency IS NOT DISTINCT FROM NEW.submitted_rate_currency
      AND OLD.submitted_rate_period IS NOT DISTINCT FROM NEW.submitted_rate_period
      AND OLD.external_reference IS NOT DISTINCT FROM NEW.external_reference
      AND OLD.external_submitted_at IS NOT DISTINCT FROM NEW.external_submitted_at)
  THEN
    RETURN NEW;
  END IF;

  -- Transition 2 -- handoff_draft to ready_for_review. All frozen.
  IF (OLD.state = 'handoff_draft' AND NEW.state = 'ready_for_review'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.talent_id = NEW.talent_id
      AND OLD.job_id = NEW.job_id
      AND OLD.evidence_package_id = NEW.evidence_package_id
      AND OLD.pinned_examination_id = NEW.pinned_examination_id
      AND OLD.created_by = NEW.created_by
      AND OLD.created_at = NEW.created_at
      AND OLD.pipeline_id IS NOT DISTINCT FROM NEW.pipeline_id
      AND OLD.resume_edition_id IS NOT DISTINCT FROM NEW.resume_edition_id
      AND OLD.justification IS NOT DISTINCT FROM NEW.justification
      AND OLD.failed_criterion_acknowledgments IS NOT DISTINCT FROM NEW.failed_criterion_acknowledgments
      AND OLD.confirmed_at IS NOT DISTINCT FROM NEW.confirmed_at
      AND OLD.revoked_at IS NOT DISTINCT FROM NEW.revoked_at
      AND OLD.revoked_by IS NOT DISTINCT FROM NEW.revoked_by
      AND OLD.revocation_justification IS NOT DISTINCT FROM NEW.revocation_justification
      AND OLD.submitted_at IS NOT DISTINCT FROM NEW.submitted_at
      AND OLD.submitted_by_actor_id IS NOT DISTINCT FROM NEW.submitted_by_actor_id
      AND OLD.delivery_channel IS NOT DISTINCT FROM NEW.delivery_channel
      AND OLD.submitted_bill_rate IS NOT DISTINCT FROM NEW.submitted_bill_rate
      AND OLD.submitted_rate_currency IS NOT DISTINCT FROM NEW.submitted_rate_currency
      AND OLD.submitted_rate_period IS NOT DISTINCT FROM NEW.submitted_rate_period
      AND OLD.external_reference IS NOT DISTINCT FROM NEW.external_reference
      AND OLD.external_submitted_at IS NOT DISTINCT FROM NEW.external_submitted_at)
  THEN
    RETURN NEW;
  END IF;

  -- Transition 3 -- ready_for_review to submitted_to_client (THE SEND). Touches state
  -- + confirmed_at (NULL->non-NULL) AND authorizes the ONE-TIME set (OLD IS NULL) of
  -- resume_edition_id + submitted_at + submitted_by_actor_id + delivery_channel +
  -- the rate snapshot + external reference/timestamp. Required-ness is app-enforced.
  -- the DB only requires they were previously NULL (never re-set after the send).
  -- pipeline_id carries forward unchanged.
  IF (OLD.state = 'ready_for_review' AND NEW.state = 'submitted_to_client'
      AND OLD.confirmed_at IS NULL AND NEW.confirmed_at IS NOT NULL
      AND OLD.resume_edition_id IS NULL
      AND OLD.submitted_at IS NULL
      AND OLD.submitted_by_actor_id IS NULL
      AND OLD.delivery_channel IS NULL
      AND OLD.submitted_bill_rate IS NULL
      AND OLD.submitted_rate_currency IS NULL
      AND OLD.submitted_rate_period IS NULL
      AND OLD.external_reference IS NULL
      AND OLD.external_submitted_at IS NULL
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.talent_id = NEW.talent_id
      AND OLD.job_id = NEW.job_id
      AND OLD.evidence_package_id = NEW.evidence_package_id
      AND OLD.pinned_examination_id = NEW.pinned_examination_id
      AND OLD.created_by = NEW.created_by
      AND OLD.created_at = NEW.created_at
      AND OLD.pipeline_id IS NOT DISTINCT FROM NEW.pipeline_id
      AND OLD.justification IS NOT DISTINCT FROM NEW.justification
      AND OLD.failed_criterion_acknowledgments IS NOT DISTINCT FROM NEW.failed_criterion_acknowledgments
      AND OLD.revoked_at IS NOT DISTINCT FROM NEW.revoked_at
      AND OLD.revoked_by IS NOT DISTINCT FROM NEW.revoked_by
      AND OLD.revocation_justification IS NOT DISTINCT FROM NEW.revocation_justification)
  THEN
    RETURN NEW;
  END IF;

  -- Transition 4 -- submitted_to_client to confirmed. All provenance frozen.
  IF (OLD.state = 'submitted_to_client' AND NEW.state = 'confirmed'
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.talent_id = NEW.talent_id
      AND OLD.job_id = NEW.job_id
      AND OLD.evidence_package_id = NEW.evidence_package_id
      AND OLD.pinned_examination_id = NEW.pinned_examination_id
      AND OLD.created_by = NEW.created_by
      AND OLD.created_at = NEW.created_at
      AND OLD.pipeline_id IS NOT DISTINCT FROM NEW.pipeline_id
      AND OLD.resume_edition_id IS NOT DISTINCT FROM NEW.resume_edition_id
      AND OLD.justification IS NOT DISTINCT FROM NEW.justification
      AND OLD.failed_criterion_acknowledgments IS NOT DISTINCT FROM NEW.failed_criterion_acknowledgments
      AND OLD.confirmed_at IS NOT DISTINCT FROM NEW.confirmed_at
      AND OLD.revoked_at IS NOT DISTINCT FROM NEW.revoked_at
      AND OLD.revoked_by IS NOT DISTINCT FROM NEW.revoked_by
      AND OLD.revocation_justification IS NOT DISTINCT FROM NEW.revocation_justification
      AND OLD.submitted_at IS NOT DISTINCT FROM NEW.submitted_at
      AND OLD.submitted_by_actor_id IS NOT DISTINCT FROM NEW.submitted_by_actor_id
      AND OLD.delivery_channel IS NOT DISTINCT FROM NEW.delivery_channel
      AND OLD.submitted_bill_rate IS NOT DISTINCT FROM NEW.submitted_bill_rate
      AND OLD.submitted_rate_currency IS NOT DISTINCT FROM NEW.submitted_rate_currency
      AND OLD.submitted_rate_period IS NOT DISTINCT FROM NEW.submitted_rate_period
      AND OLD.external_reference IS NOT DISTINCT FROM NEW.external_reference
      AND OLD.external_submitted_at IS NOT DISTINCT FROM NEW.external_submitted_at)
  THEN
    RETURN NEW;
  END IF;

  -- Sibling-revoke -- any non-confirmed to revoked. Provenance frozen (null on a
  -- pre-send revoke, the pinned values on a revoke from submitted_to_client).
  IF (NEW.state = 'revoked'
      AND OLD.state IN ('created', 'handoff_draft', 'ready_for_review', 'submitted_to_client')
      AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
      AND OLD.revoked_by IS NULL AND NEW.revoked_by IS NOT NULL
      AND OLD.revocation_justification IS NULL AND NEW.revocation_justification IS NOT NULL
      AND OLD.confirmed_at IS NOT DISTINCT FROM NEW.confirmed_at
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.talent_id = NEW.talent_id
      AND OLD.job_id = NEW.job_id
      AND OLD.evidence_package_id = NEW.evidence_package_id
      AND OLD.pinned_examination_id = NEW.pinned_examination_id
      AND OLD.created_by = NEW.created_by
      AND OLD.created_at = NEW.created_at
      AND OLD.pipeline_id IS NOT DISTINCT FROM NEW.pipeline_id
      AND OLD.resume_edition_id IS NOT DISTINCT FROM NEW.resume_edition_id
      AND OLD.justification IS NOT DISTINCT FROM NEW.justification
      AND OLD.failed_criterion_acknowledgments IS NOT DISTINCT FROM NEW.failed_criterion_acknowledgments
      AND OLD.submitted_at IS NOT DISTINCT FROM NEW.submitted_at
      AND OLD.submitted_by_actor_id IS NOT DISTINCT FROM NEW.submitted_by_actor_id
      AND OLD.delivery_channel IS NOT DISTINCT FROM NEW.delivery_channel
      AND OLD.submitted_bill_rate IS NOT DISTINCT FROM NEW.submitted_bill_rate
      AND OLD.submitted_rate_currency IS NOT DISTINCT FROM NEW.submitted_rate_currency
      AND OLD.submitted_rate_period IS NOT DISTINCT FROM NEW.submitted_rate_period
      AND OLD.external_reference IS NOT DISTINCT FROM NEW.external_reference
      AND OLD.external_submitted_at IS NOT DISTINCT FROM NEW.external_submitted_at)
  THEN
    RETURN NEW;
  END IF;

  -- Fallthrough -- any other move (including any non-authorized mutation of a frozen
  -- provenance / identity / resume_edition_id / pipeline_id field) is rejected.
  RAISE EXCEPTION
    'TalentSubmittalRecord state machine permits only the canonical 5-state mainline (created -> handoff_draft -> ready_for_review -> submitted_to_client -> confirmed) and sibling lifecycle-exit (any non-confirmed -> revoked); business/identity/provenance fields are immutable except where a transition explicitly authorizes their one-time change'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
