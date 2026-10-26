-- CCP-A3 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A3; Charter §6.4, D6, D8,
-- D9; NC-5 ratified by the Lead Architect 2026-10-25, doc/ccp/decisions.md TD-A3-0)
-- — change request, approval and the D9 operator attestation.
--
-- ADDITIVE ONLY: three new tables, their indexes, guard functions and triggers, and one
-- new FK on subscription."CommercialAuditEvent".change_request_id (A2 left it FK-less for
-- this slice). No existing column, index or row changes. No domain data mutates: A3 never
-- applies a request (A6).
--
-- CommercialChangeRequest
--   action_type  closed set (CHECK). kind NORMAL | EXCEPTION | MIGRATION (CHECK).
--   state        DRAFT → PENDING_APPROVAL → APPROVED; REJECTED, EXPIRED, WITHDRAWN terminal.
--                APPLYING, APPLIED, APPLY_FAILED are admitted by the CHECK but the guard
--                trigger refuses every move into them: they are unreachable until CCP-A6
--                replaces guard_commercial_change_request() with the apply transitions.
--   payload + payload_checksum, required_chain, policy_version_id + policy_checksum,
--                requested_by, reason, idempotency_key, tenant_id, product_key: immutable
--                from INSERT (trigger). The checksum is SHA-256 of the canonical JSON
--                (libs/subscription canonicalJson); the service recomputes it on every
--                approve and refuses on mismatch.
--   APPROVED     requires one CommercialApproval per snapshotted step (trigger backstop:
--                no approval bypass through SQL, PBD §12).
--   Q14          one open request per tenant × product (partial unique index). product_key
--                has NO DB default (PBD §7.1); the A3 interim closed set is 'sign' only,
--                replaced by the A4 governed product registry.
--   idempotency_key UNIQUE.
--
-- CommercialApproval: append-only (UPDATE and DELETE rejected unconditionally).
--   UNIQUE(change_request_id, approver_user_id) and UNIQUE(change_request_id, step_index)
--   (D8). An INSERT is admitted only while the request is PENDING_APPROVAL and only for
--   the next unfilled step (in-order backstop). Requester ≠ approver is NOT a DB rule
--   (D8; R-SOD, Commercial-Approval Directive :89-92, not reinterpreted): it is the
--   SELF_APPROVAL refusal in the approve transaction.
--
-- CommercialOperatorAttestation (D9): one-account-per-human attestation for platform
--   operators. At most one active attestation per user and per attested human reference
--   (partial unique indexes). Rows are never deleted; the only UPDATE allowed is a single
--   revocation (revoked_at / revoked_by / revoke_reason from NULL). No PII: the human
--   reference is a SHA-256 hex digest supplied by the attesting operator.
--
-- Carries dollar-quoted trigger bodies: any spec applying this migration MUST use a
-- whole-file DDL applier (pg Client), never a line splitter.
--
-- Compensating migration (documented, not shipped; doc/ccp/slices/CCP-A3-acceptance.md):
-- drop the FK on CommercialAuditEvent, then the three tables and their guard functions.
-- Guarded to RAISE if any CommercialChangeRequest row exists.

-- ---------------------------------------------------------------------------------------
-- CommercialChangeRequest
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."CommercialChangeRequest" (
    "id" UUID NOT NULL,
    "action_type" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    -- Tenant-scoped actions carry tenant_id + product_key; catalog, policy and role
    -- actions carry neither.
    "tenant_id" UUID,
    "product_key" TEXT,
    "payload" JSONB NOT NULL,
    "payload_checksum" TEXT NOT NULL,
    -- The approval chain resolved from the policy version below when the request was
    -- created (D6); never recomputed (NC-5).
    "required_chain" JSONB NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "policy_checksum" TEXT NOT NULL,
    "requested_by" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "submitted_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "approved_at" TIMESTAMPTZ(3),
    "rejected_at" TIMESTAMPTZ(3),
    "rejected_by" UUID,
    "rejection_reason" TEXT,
    "withdrawn_at" TIMESTAMPTZ(3),
    "expired_at" TIMESTAMPTZ(3),
    -- CCP-A6 (apply). Unused in A3.
    "apply_attempts" INTEGER NOT NULL DEFAULT 0,
    "applied_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CommercialChangeRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommercialChangeRequest_action_type_check" CHECK ("action_type" IN (
        'SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END',
        'ENTITLEMENT_GRANT', 'ENTITLEMENT_REVOKE',
        'PLAN_VERSION_PUBLISH', 'PLAN_RETIRE',
        'POLICY_ACTIVATE',
        'SUPPORT_EXTENSION',
        'ROLE_GRANT', 'ROLE_REVOKE',
        'CREDIT', 'DISCOUNT',
        'CONVERSION')),
    CONSTRAINT "CommercialChangeRequest_kind_check" CHECK ("kind" IN ('NORMAL', 'EXCEPTION', 'MIGRATION')),
    CONSTRAINT "CommercialChangeRequest_state_check" CHECK ("state" IN (
        'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'APPLYING', 'APPLIED', 'APPLY_FAILED',
        'REJECTED', 'EXPIRED', 'WITHDRAWN')),
    CONSTRAINT "CommercialChangeRequest_tenant_product_check" CHECK (("tenant_id" IS NULL) = ("product_key" IS NULL)),
    -- A3 interim closed product set; CCP-A4 replaces it with the governed registry.
    CONSTRAINT "CommercialChangeRequest_product_key_check" CHECK ("product_key" IS NULL OR "product_key" IN ('sign')),
    CONSTRAINT "CommercialChangeRequest_payload_check" CHECK (jsonb_typeof("payload") = 'object'),
    CONSTRAINT "CommercialChangeRequest_payload_checksum_check" CHECK ("payload_checksum" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "CommercialChangeRequest_policy_checksum_check" CHECK ("policy_checksum" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "CommercialChangeRequest_required_chain_check" CHECK (
        jsonb_typeof("required_chain") = 'object'
        AND jsonb_typeof("required_chain" -> 'steps') = 'array'),
    CONSTRAINT "CommercialChangeRequest_reason_check" CHECK (length("reason") BETWEEN 1 AND 2000),
    CONSTRAINT "CommercialChangeRequest_idempotency_key_check" CHECK (length("idempotency_key") BETWEEN 8 AND 200),
    CONSTRAINT "CommercialChangeRequest_submitted_check" CHECK (("state" = 'DRAFT') = ("submitted_at" IS NULL)
        OR ("state" = 'WITHDRAWN' AND "submitted_at" IS NULL)),
    CONSTRAINT "CommercialChangeRequest_expires_check" CHECK (("submitted_at" IS NULL) = ("expires_at" IS NULL)),
    CONSTRAINT "CommercialChangeRequest_apply_attempts_check" CHECK ("apply_attempts" >= 0),
    CONSTRAINT "CommercialChangeRequest_policy_version_id_fkey" FOREIGN KEY ("policy_version_id")
        REFERENCES "subscription"."CommercialPolicyVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "CommercialChangeRequest_idempotency_key_key" ON "subscription"."CommercialChangeRequest"("idempotency_key");
-- Q14 (PO 2026-10-24): one open request per tenant × product.
CREATE UNIQUE INDEX "CommercialChangeRequest_one_open_per_tenant_product_key"
    ON "subscription"."CommercialChangeRequest"("tenant_id", "product_key")
    WHERE "tenant_id" IS NOT NULL
      AND "state" IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'APPLYING', 'APPLY_FAILED');
CREATE INDEX "CommercialChangeRequest_state_created_at_id_idx" ON "subscription"."CommercialChangeRequest"("state", "created_at" DESC, "id" DESC);
CREATE INDEX "CommercialChangeRequest_requested_by_created_at_id_idx" ON "subscription"."CommercialChangeRequest"("requested_by", "created_at" DESC, "id" DESC);
CREATE INDEX "CommercialChangeRequest_created_at_id_idx" ON "subscription"."CommercialChangeRequest"("created_at" DESC, "id" DESC);

CREATE OR REPLACE FUNCTION "subscription"."guard_commercial_change_request"()
RETURNS TRIGGER AS $$
DECLARE
    steps INTEGER;
    approvals INTEGER;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'CommercialChangeRequest is append-only (DELETE rejected)';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'DRAFT' THEN
            RAISE EXCEPTION 'CommercialChangeRequest is created in DRAFT (got %)', NEW."state";
        END IF;
        RETURN NEW;
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."action_type" IS DISTINCT FROM OLD."action_type"
       OR NEW."kind" IS DISTINCT FROM OLD."kind"
       OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."product_key" IS DISTINCT FROM OLD."product_key"
       OR NEW."payload" IS DISTINCT FROM OLD."payload"
       OR NEW."payload_checksum" IS DISTINCT FROM OLD."payload_checksum"
       OR NEW."required_chain" IS DISTINCT FROM OLD."required_chain"
       OR NEW."policy_version_id" IS DISTINCT FROM OLD."policy_version_id"
       OR NEW."policy_checksum" IS DISTINCT FROM OLD."policy_checksum"
       OR NEW."requested_by" IS DISTINCT FROM OLD."requested_by"
       OR NEW."reason" IS DISTINCT FROM OLD."reason"
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'CommercialChangeRequest payload, chain and identity are immutable';
    END IF;
    IF OLD."submitted_at" IS NOT NULL
       AND (NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
            OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at") THEN
        RAISE EXCEPTION 'CommercialChangeRequest submitted_at and expires_at are immutable once set';
    END IF;
    IF OLD."state" IN ('APPLIED', 'REJECTED', 'EXPIRED', 'WITHDRAWN') THEN
        RAISE EXCEPTION 'CommercialChangeRequest in terminal state % is immutable', OLD."state";
    END IF;
    IF NEW."state" IS DISTINCT FROM OLD."state" THEN
        -- CCP-A3 transitions only. APPLYING / APPLIED / APPLY_FAILED are unreachable until
        -- CCP-A6 replaces this function.
        IF NOT ((OLD."state" = 'DRAFT' AND NEW."state" IN ('PENDING_APPROVAL', 'WITHDRAWN'))
             OR (OLD."state" = 'PENDING_APPROVAL' AND NEW."state" IN ('APPROVED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'))) THEN
            RAISE EXCEPTION 'CommercialChangeRequest state % -> % is not allowed', OLD."state", NEW."state";
        END IF;
        IF NEW."state" = 'APPROVED' THEN
            steps := jsonb_array_length(NEW."required_chain" -> 'steps');
            SELECT count(*) INTO approvals FROM "subscription"."CommercialApproval" WHERE "change_request_id" = NEW."id";
            IF steps < 1 OR approvals <> steps THEN
                RAISE EXCEPTION 'CommercialChangeRequest cannot be APPROVED with % of % approvals', approvals, steps;
            END IF;
        END IF;
    ELSE
        RAISE EXCEPTION 'CommercialChangeRequest columns change only with a state transition';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "commercial_change_request_guard_insert"
    BEFORE INSERT ON "subscription"."CommercialChangeRequest"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_commercial_change_request"();

CREATE TRIGGER "commercial_change_request_guard_update"
    BEFORE UPDATE ON "subscription"."CommercialChangeRequest"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_commercial_change_request"();

CREATE TRIGGER "commercial_change_request_guard_delete"
    BEFORE DELETE ON "subscription"."CommercialChangeRequest"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_commercial_change_request"();

-- ---------------------------------------------------------------------------------------
-- CommercialOperatorAttestation (D9)
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."CommercialOperatorAttestation" (
    "id" UUID NOT NULL,
    -- identity."User".id of the platform operator (UUID-only, no cross-schema FK).
    "user_id" UUID NOT NULL,
    -- SHA-256 hex of the attested human reference (no PII stored).
    "human_ref_hash" TEXT NOT NULL,
    "statement_version" TEXT NOT NULL,
    -- BOOTSTRAP: the D7 operator (CCP-A9). PLATFORM_OWNER: attested by a distinct platform_owner.
    "method" TEXT NOT NULL,
    "attested_by" UUID NOT NULL,
    "attested_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by" UUID,
    "revoke_reason" TEXT,

    CONSTRAINT "CommercialOperatorAttestation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommercialOperatorAttestation_human_ref_hash_check" CHECK ("human_ref_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "CommercialOperatorAttestation_statement_version_check" CHECK ("statement_version" ~ '^D9-v[0-9]+$'),
    CONSTRAINT "CommercialOperatorAttestation_method_check" CHECK ("method" IN ('BOOTSTRAP', 'PLATFORM_OWNER')),
    CONSTRAINT "CommercialOperatorAttestation_distinct_attester_check" CHECK ("method" <> 'PLATFORM_OWNER' OR "attested_by" <> "user_id"),
    CONSTRAINT "CommercialOperatorAttestation_bootstrap_self_check" CHECK ("method" <> 'BOOTSTRAP' OR "attested_by" = "user_id"),
    CONSTRAINT "CommercialOperatorAttestation_revoked_check" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL))
);

-- One active attestation per account, and one active account per attested human.
CREATE UNIQUE INDEX "CommercialOperatorAttestation_active_user_key" ON "subscription"."CommercialOperatorAttestation"("user_id") WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX "CommercialOperatorAttestation_active_human_key" ON "subscription"."CommercialOperatorAttestation"("human_ref_hash") WHERE "revoked_at" IS NULL;

CREATE OR REPLACE FUNCTION "subscription"."guard_commercial_operator_attestation"()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'CommercialOperatorAttestation is append-only (DELETE rejected)';
    END IF;
    IF OLD."revoked_at" IS NOT NULL
       OR NEW."revoked_at" IS NULL
       OR (to_jsonb(NEW) - 'revoked_at' - 'revoked_by' - 'revoke_reason')
          <> (to_jsonb(OLD) - 'revoked_at' - 'revoked_by' - 'revoke_reason') THEN
        RAISE EXCEPTION 'CommercialOperatorAttestation allows only a single revocation (UPDATE rejected)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "commercial_operator_attestation_guard_update"
    BEFORE UPDATE ON "subscription"."CommercialOperatorAttestation"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_commercial_operator_attestation"();

CREATE TRIGGER "commercial_operator_attestation_guard_delete"
    BEFORE DELETE ON "subscription"."CommercialOperatorAttestation"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_commercial_operator_attestation"();

-- ---------------------------------------------------------------------------------------
-- CommercialApproval (append-only; D8 unique indexes)
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."CommercialApproval" (
    "id" UUID NOT NULL,
    "change_request_id" UUID NOT NULL,
    "step_index" INTEGER NOT NULL,
    "approver_user_id" UUID NOT NULL,
    -- The snapshotted step this approval satisfied.
    "step_role_key" TEXT NOT NULL,
    "step_scope_keys" TEXT[] NOT NULL,
    -- Server-side snapshot of the approver's live role keys at approval time (evidence).
    "approver_role_keys" TEXT[] NOT NULL,
    "attestation_id" UUID NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CommercialApproval_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommercialApproval_step_index_check" CHECK ("step_index" >= 0),
    CONSTRAINT "CommercialApproval_comment_check" CHECK ("comment" IS NULL OR length("comment") <= 2000),
    CONSTRAINT "CommercialApproval_change_request_id_fkey" FOREIGN KEY ("change_request_id")
        REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialApproval_attestation_id_fkey" FOREIGN KEY ("attestation_id")
        REFERENCES "subscription"."CommercialOperatorAttestation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- D8: no user approves two steps; each step is approved once.
CREATE UNIQUE INDEX "CommercialApproval_change_request_id_approver_user_id_key" ON "subscription"."CommercialApproval"("change_request_id", "approver_user_id");
CREATE UNIQUE INDEX "CommercialApproval_change_request_id_step_index_key" ON "subscription"."CommercialApproval"("change_request_id", "step_index");
CREATE INDEX "CommercialApproval_approver_user_id_idx" ON "subscription"."CommercialApproval"("approver_user_id");

CREATE OR REPLACE FUNCTION "subscription"."reject_commercial_approval_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'CommercialApproval is append-only evidence (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "subscription"."guard_commercial_approval_insert"()
RETURNS TRIGGER AS $$
DECLARE
    req_state TEXT;
    steps INTEGER;
    filled INTEGER;
BEGIN
    SELECT "state", jsonb_array_length("required_chain" -> 'steps') INTO req_state, steps
      FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."change_request_id";
    IF req_state IS DISTINCT FROM 'PENDING_APPROVAL' THEN
        RAISE EXCEPTION 'CommercialApproval requires a PENDING_APPROVAL request (state %)', req_state;
    END IF;
    SELECT count(*) INTO filled FROM "subscription"."CommercialApproval" WHERE "change_request_id" = NEW."change_request_id";
    IF NEW."step_index" <> filled OR NEW."step_index" >= steps THEN
        RAISE EXCEPTION 'CommercialApproval step % is out of order (next step %, % steps)', NEW."step_index", filled, steps;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "commercial_approval_guard_insert"
    BEFORE INSERT ON "subscription"."CommercialApproval"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."guard_commercial_approval_insert"();

CREATE TRIGGER "commercial_approval_no_update"
    BEFORE UPDATE ON "subscription"."CommercialApproval"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."reject_commercial_approval_mutation"();

CREATE TRIGGER "commercial_approval_no_delete"
    BEFORE DELETE ON "subscription"."CommercialApproval"
    FOR EACH ROW
    EXECUTE FUNCTION "subscription"."reject_commercial_approval_mutation"();

-- ---------------------------------------------------------------------------------------
-- CommercialAuditEvent.change_request_id → CommercialChangeRequest (deferred from A2)
-- ---------------------------------------------------------------------------------------
ALTER TABLE "subscription"."CommercialAuditEvent"
    ADD CONSTRAINT "CommercialAuditEvent_change_request_id_fkey" FOREIGN KEY ("change_request_id")
        REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "CommercialAuditEvent_change_request_id_created_at_id_idx" ON "subscription"."CommercialAuditEvent"("change_request_id", "created_at" DESC, "id" DESC);
