-- Requisition Workflow slice #4 -- Commercial Approval (LOCKED
-- Aramo-Commercial-Approval-Directive-v1_0). Adds the CommercialRevisionProposal
-- governance aggregate that sits IN FRONT OF createCommercialRevision. Additive
-- and backward-compatible: the new tables start empty and no existing object is
-- altered. AssignmentRateVersion and its append-only / GiST / first-close
-- substrate are UNTOUCHED (the governing invariant: proposal = INTENT, approval =
-- AUTHORITY, AssignmentRateVersion = APPLIED FINANCIAL TRUTH).
--
-- The per-edge transition guard, the terminal freeze and the one-live
-- partial-unique are HAND-SYNCED to the registry
-- (libs/placement/src/lib/lifecycle/commercial-approval-lifecycle.ts) -- the
-- Assignment-Extension hand-authored-trigger precedent, NOT the offer byte-check
-- generator. Any edit to LEGAL_COMMERCIAL_PROPOSAL_TRANSITIONS must be mirrored
-- in the edge list below.
--
-- NOTE keep every line comment free of the statement terminator and of the
-- dollar-quote delimiter -- the integration migration splitter is dollar-quote
-- aware but does not strip line comments (T6-B3 precedent).

-- 1. Enums (state machine + client-approval provenance). Order mirrors the
-- registry constant arrays.
CREATE TYPE "placement"."CommercialProposalState" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'PENDING_CLIENT_APPROVAL', 'APPROVED', 'APPLIED', 'REJECTED', 'WITHDRAWN');
CREATE TYPE "placement"."CommercialProposalEventType" AS ENUM ('state_transition');
CREATE TYPE "placement"."CommercialApprovalSource" AS ENUM ('MANUAL', 'EMAIL', 'VMS', 'CLIENT_PORTAL', 'API');

-- 2. The proposal aggregate. Nullable evidence columns (margin review / client
-- approval / rejection / applied) are set once at their transition and are
-- app-surface immutable -- they are NEVER pinned in the transition trigger below
-- (the NULL=NULL trap). Derived margin is NOT stored. No FK on the UUID refs.
CREATE TABLE "placement"."CommercialRevisionProposal" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "contract_assignment_id" UUID NOT NULL,
  "placement_process_id" UUID NOT NULL,
  "requisition_id" UUID NOT NULL,
  "talent_record_id" UUID NOT NULL,
  "reference_rate_version_id" UUID NOT NULL,
  "proposed_pay_rate_amount" DECIMAL(12,2) NOT NULL,
  "proposed_bill_rate_amount" DECIMAL(12,2) NOT NULL,
  "proposed_currency" TEXT NOT NULL,
  "proposed_rate_period" TEXT NOT NULL,
  "proposed_effective_from" TIMESTAMPTZ(6),
  "reason" TEXT NOT NULL,
  "state" "placement"."CommercialProposalState" NOT NULL,
  "requested_by" UUID NOT NULL,
  "review_decided_by" UUID,
  "review_decided_at" TIMESTAMPTZ(6),
  "review_note" TEXT,
  "client_approved_at" TIMESTAMPTZ(6),
  "client_approval_recorded_by" UUID,
  "client_reference" TEXT,
  "client_approval_source" "placement"."CommercialApprovalSource",
  "client_approval_note" TEXT,
  "rejected_by" UUID,
  "rejected_at" TIMESTAMPTZ(6),
  "rejection_reason" TEXT,
  "applied_rate_version_id" UUID,
  "applied_by" UUID,
  "applied_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "CommercialRevisionProposal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CommercialRevisionProposal_tenant_assignment_idx" ON "placement"."CommercialRevisionProposal" ("tenant_id", "contract_assignment_id");
CREATE INDEX "CommercialRevisionProposal_tenant_placement_idx" ON "placement"."CommercialRevisionProposal" ("tenant_id", "placement_process_id");
CREATE INDEX "CommercialRevisionProposal_tenant_requisition_idx" ON "placement"."CommercialRevisionProposal" ("tenant_id", "requisition_id");

-- 3. One-live guard (R-PROPOSAL-AGGREGATE): at most one NON-terminal proposal per
-- (tenant_id, contract_assignment_id). Partial UNIQUE INDEX (race-free, unlike an
-- EXISTS trigger). Terminal states (APPLIED / REJECTED / WITHDRAWN) release the
-- guard so a new proposal may follow a closed one.
CREATE UNIQUE INDEX "CommercialRevisionProposal_one_live_idx"
  ON "placement"."CommercialRevisionProposal" ("tenant_id", "contract_assignment_id")
  WHERE "state" NOT IN ('APPLIED', 'REJECTED', 'WITHDRAWN');

-- 4. The append-only transition audit log (mirrors OfferEvent).
CREATE TABLE "placement"."CommercialRevisionProposalEvent" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "proposal_id" UUID NOT NULL,
  "event_type" "placement"."CommercialProposalEventType" NOT NULL,
  "event_payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "CommercialRevisionProposalEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialRevisionProposalEvent_proposal_fk" FOREIGN KEY ("proposal_id") REFERENCES "placement"."CommercialRevisionProposal" ("id")
);

CREATE INDEX "CommercialRevisionProposalEvent_tenant_proposal_idx" ON "placement"."CommercialRevisionProposalEvent" ("tenant_id", "proposal_id");
CREATE INDEX "CommercialRevisionProposalEvent_proposal_created_idx" ON "placement"."CommercialRevisionProposalEvent" ("proposal_id", "created_at");

-- 5. Transition guard (hand-synced to the registry). Identity + proposed-terms
-- columns are immutable on EVERY transition (checked once up front -- all are
-- non-null, so no NULL-equality trap). Then only a legal (from,to) edge is
-- permitted. Any other UPDATE (including any UPDATE out of a terminal state = the
-- terminal freeze) is rejected.
CREATE FUNCTION placement.enforce_commercial_proposal_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT (
    OLD.id = NEW.id
    AND OLD.tenant_id = NEW.tenant_id
    AND OLD.contract_assignment_id = NEW.contract_assignment_id
    AND OLD.placement_process_id = NEW.placement_process_id
    AND OLD.requisition_id = NEW.requisition_id
    AND OLD.talent_record_id = NEW.talent_record_id
    AND OLD.reference_rate_version_id = NEW.reference_rate_version_id
    AND OLD.proposed_pay_rate_amount = NEW.proposed_pay_rate_amount
    AND OLD.proposed_bill_rate_amount = NEW.proposed_bill_rate_amount
    AND OLD.proposed_currency = NEW.proposed_currency
    AND OLD.proposed_rate_period = NEW.proposed_rate_period
    AND OLD.reason = NEW.reason
    AND OLD.requested_by = NEW.requested_by
    AND OLD.created_at = NEW.created_at
  ) THEN
    RAISE EXCEPTION 'CommercialRevisionProposal identity and proposed-terms columns are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF (OLD.state = 'DRAFT' AND NEW.state = 'PENDING_REVIEW') THEN RETURN NEW; END IF;
  IF (OLD.state = 'DRAFT' AND NEW.state = 'WITHDRAWN') THEN RETURN NEW; END IF;
  IF (OLD.state = 'PENDING_REVIEW' AND NEW.state = 'PENDING_CLIENT_APPROVAL') THEN RETURN NEW; END IF;
  IF (OLD.state = 'PENDING_REVIEW' AND NEW.state = 'REJECTED') THEN RETURN NEW; END IF;
  IF (OLD.state = 'PENDING_REVIEW' AND NEW.state = 'WITHDRAWN') THEN RETURN NEW; END IF;
  IF (OLD.state = 'PENDING_CLIENT_APPROVAL' AND NEW.state = 'APPROVED') THEN RETURN NEW; END IF;
  IF (OLD.state = 'PENDING_CLIENT_APPROVAL' AND NEW.state = 'REJECTED') THEN RETURN NEW; END IF;
  IF (OLD.state = 'PENDING_CLIENT_APPROVAL' AND NEW.state = 'WITHDRAWN') THEN RETURN NEW; END IF;
  IF (OLD.state = 'APPROVED' AND NEW.state = 'APPLIED') THEN RETURN NEW; END IF;
  IF (OLD.state = 'APPROVED' AND NEW.state = 'WITHDRAWN') THEN RETURN NEW; END IF;

  RAISE EXCEPTION 'illegal CommercialRevisionProposal transition from % to %', OLD.state, NEW.state
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CommercialRevisionProposal_transition"
  BEFORE UPDATE ON "placement"."CommercialRevisionProposal"
  FOR EACH ROW EXECUTE FUNCTION placement.enforce_commercial_proposal_transition();

-- 6. Event-log immutability (append-only). No UPDATE ever. DELETE only under the
-- tenant-reset escape (mirrors the AssignmentExtension / AssignmentRateVersion
-- single-pass reset path). Nullable columns are never compared here.
CREATE FUNCTION placement.reject_commercial_proposal_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.tenant_reset', true) = 'authorized' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'placement.CommercialRevisionProposalEvent is append-only -- DELETE is not permitted'
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'placement.CommercialRevisionProposalEvent is append-only -- UPDATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CommercialRevisionProposalEvent_append_only"
  BEFORE UPDATE OR DELETE ON "placement"."CommercialRevisionProposalEvent"
  FOR EACH ROW EXECUTE FUNCTION placement.reject_commercial_proposal_event_mutation();
