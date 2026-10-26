-- CCP-A9 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A9; T2-F1-H3 Amendment A1
-- A1-2; Inc-1 Closure Amendment A1 A1-3) — the narrow role-change apply path and the
-- one-time bootstrap backstops.
--
-- 1. guard_commercial_change_request() is replaced by the CCP-A3 body plus EXACTLY two
--    transitions, APPROVED → APPLYING → APPLIED, admitted ONLY for action_type ROLE_GRANT /
--    ROLE_REVOKE (doc/ccp/slices/CCP-A9-pre-execution.md C-1; typed divergence TD-A9-1).
--    Every other action keeps the A3 table: APPLYING / APPLIED / APPLY_FAILED stay unreachable
--    for them until CCP-A6 replaces this function — and A6 MUST carry these two role-only
--    transitions forward. APPLY_FAILED stays unreachable for every action. APPLIED requires
--    applied_at.
-- 2. One BOOTSTRAP attestation ever (D7 "one-time"): partial unique index on method.
-- 3. One platform-owner bootstrap audit event ever: partial unique index on event_type.
--
-- ADDITIVE: one function body replaced (same name, same triggers), two new indexes. No row,
-- column or constraint changes. The function carries a dollar-quoted body: any spec applying
-- this migration MUST use a whole-file DDL applier (pg Client), never a line splitter.
--
-- Compensating migration (documented, not shipped; doc/ccp/slices/CCP-A9-acceptance.md):
-- RAISE if any request is APPLYING or APPLIED; re-create the CCP-A3 function body
-- (20261025120000); drop the two indexes.

CREATE OR REPLACE FUNCTION "subscription"."guard_commercial_change_request"()
RETURNS TRIGGER AS $$
DECLARE
    steps INTEGER;
    approvals INTEGER;
    role_change BOOLEAN;
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
        role_change := OLD."action_type" IN ('ROLE_GRANT', 'ROLE_REVOKE');
        -- CCP-A3 transitions, plus the CCP-A9 role-change apply (role actions only).
        IF NOT ((OLD."state" = 'DRAFT' AND NEW."state" IN ('PENDING_APPROVAL', 'WITHDRAWN'))
             OR (OLD."state" = 'PENDING_APPROVAL' AND NEW."state" IN ('APPROVED', 'REJECTED', 'EXPIRED', 'WITHDRAWN'))
             OR (role_change AND OLD."state" = 'APPROVED' AND NEW."state" = 'APPLYING')
             OR (role_change AND OLD."state" = 'APPLYING' AND NEW."state" = 'APPLIED')) THEN
            RAISE EXCEPTION 'CommercialChangeRequest state % -> % is not allowed', OLD."state", NEW."state";
        END IF;
        IF NEW."state" = 'APPROVED' THEN
            steps := jsonb_array_length(NEW."required_chain" -> 'steps');
            SELECT count(*) INTO approvals FROM "subscription"."CommercialApproval" WHERE "change_request_id" = NEW."id";
            IF steps < 1 OR approvals <> steps THEN
                RAISE EXCEPTION 'CommercialChangeRequest cannot be APPROVED with % of % approvals', approvals, steps;
            END IF;
        END IF;
        IF NEW."state" = 'APPLIED' AND NEW."applied_at" IS NULL THEN
            RAISE EXCEPTION 'CommercialChangeRequest cannot be APPLIED without applied_at';
        END IF;
    ELSE
        RAISE EXCEPTION 'CommercialChangeRequest columns change only with a state transition';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- D7 one-time backstops (T2-F1-H3 Amendment A1 A1-2(3), (6)).
CREATE UNIQUE INDEX "CommercialOperatorAttestation_one_bootstrap_key"
    ON "subscription"."CommercialOperatorAttestation"("method") WHERE "method" = 'BOOTSTRAP';
CREATE UNIQUE INDEX "CommercialAuditEvent_one_platform_owner_bootstrap_key"
    ON "subscription"."CommercialAuditEvent"("event_type") WHERE "event_type" = 'COMMERCIAL_PLATFORM_OWNER_BOOTSTRAPPED';
