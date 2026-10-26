-- CCP-C8-PR (Aramo-CCP-Program-Build-Directive-Amendment-A2-Payment-Record-v1_0-LOCKED, SHA-256
-- 4409e3a1…; PR-1 … PR-13 and §4, the K-2 creation sequence) — PAYMENT_RECORD and enterprise
-- payment-gated activation.
--
-- CCP records, with evidence and governance, that an enterprise payment was received OUTSIDE Aramo
-- (a commercial receipt attestation, never a general-ledger entry). Invoicing stays outside Aramo,
-- there is no accounting integration and no payment collection (§1).
--
-- ADDITIVE ONLY. This migration adds:
--   1. the PR-1 contractual payment terms on "Contract" (ADD-not-rename: five new nullable columns,
--      all-or-nothing, immutable because the table is append-only) and a BEFORE INSERT trigger that
--      refuses a CHANGE_REQUEST contract without them;
--   2. "ContractPaymentObligation" (one PR-1 obligation; NOT NULL FK to its Contract), append-only,
--      written only inside the A6 apply of a SUBSCRIPTION_OPEN / SUBSCRIPTION_CHANGE;
--   3. "CommercialPaymentReceipt" (§4.1, the append-only attestation; NOT NULL FK to its governing
--      PAYMENT_RECORD change request; nullable FKs to Contract and obligation, RESTRICT), with the
--      §4.1 linkage CHECKs, the §4.2 provisional identity and its partial unique index, the PR-6
--      uniqueness indexes, an insert guard and an update guard. The ONLY updates are (a) the §4.3 link
--      inside the SUBSCRIPTION_OPEN apply (the cross-tenant / product / ref guard) and (b) the PR-9
--      supersession mark of a CORRECT; everything else, and every DELETE, raises;
--   4. the deferred "never commit in APPLYING" backstop for PAYMENT_RECORD (CCP-A6's function).
--
-- NOT here (integrator-owned union files, labelled "CCP-C8-PR" blocks, updated in place):
--   20261027000000_ccp_guard_union        the PAYMENT_RECORD transition pairs, attempt rules, APPLIED check
--   20261027000100_ccp_constraint_union   PAYMENT_RECORD in the two action-type CHECKs and the
--                                         application subscription CHECK
--   20261029000100_ccp_alert_type_union   the D3 alert PAYMENT_RECEIPT_UNLINKED
--
-- MP-A2 N-3 (the N-4 statement, doc/ccp/slices/CCP-C8PR-pre-execution.md): both tables live in the
-- subscription schema; the obligation references its Contract (which keeps its NOT NULL FK to the
-- TenantSubscription it governs); the receipt references its governing change request, and once linked
-- its Contract and obligation; neither answers "which plan, allowance or subscription"; neither carries
-- a subscription-like or entitlement-like state, a usage ledger or a balance (payment status is derived,
-- PR-10, never stored).
--
-- Carries dollar-quoted function bodies: apply whole-file (pg Client), never a line splitter.
-- Compensation (documented, not shipped): src/tests/fixtures/ccp-c8pr-compensating.sql.
-- Design approval is not production migration authority (ruling A0-C15).

-- ---------------------------------------------------------------------------------------
-- 1. PR-1 payment terms on Contract
-- ---------------------------------------------------------------------------------------
ALTER TABLE "subscription"."Contract"
    ADD COLUMN "billing_mode" TEXT,
    ADD COLUMN "payment_currency" TEXT,
    ADD COLUMN "payment_timezone" TEXT,
    -- NULL = absent = 0 grace days (PR-1: no default is ever invented; the absence is kept).
    ADD COLUMN "grace_days" INTEGER,
    -- POSTPAID only: the explicit, immutable marker with its evidence (PR-1).
    ADD COLUMN "postpaid_approval" JSONB;

ALTER TABLE "subscription"."Contract"
    ADD CONSTRAINT "Contract_billing_mode_check" CHECK ("billing_mode" IS NULL OR "billing_mode" IN ('PREPAID', 'POSTPAID')),
    ADD CONSTRAINT "Contract_payment_terms_all_or_none_check" CHECK (
        ("billing_mode" IS NULL) = ("payment_currency" IS NULL) AND ("billing_mode" IS NULL) = ("payment_timezone" IS NULL)),
    ADD CONSTRAINT "Contract_payment_currency_check" CHECK ("payment_currency" IS NULL OR "payment_currency" = 'USD'),
    ADD CONSTRAINT "Contract_payment_timezone_check" CHECK ("payment_timezone" IS NULL OR length("payment_timezone") BETWEEN 1 AND 64),
    ADD CONSTRAINT "Contract_grace_days_check" CHECK ("grace_days" IS NULL OR ("billing_mode" IS NOT NULL AND "grace_days" BETWEEN 0 AND 3650)),
    ADD CONSTRAINT "Contract_postpaid_approval_check" CHECK (
        ("postpaid_approval" IS NOT NULL) = ("billing_mode" IS NOT DISTINCT FROM 'POSTPAID')
        AND ("postpaid_approval" IS NULL OR jsonb_typeof("postpaid_approval") = 'object'));

CREATE FUNCTION "subscription"."guard_contract_payment_terms"()
RETURNS TRIGGER AS $$
BEGIN
    -- PR-1: a contract recorded by a change request carries its payment terms; never assumed.
    IF NEW."provenance" = 'CHANGE_REQUEST' AND NEW."billing_mode" IS NULL THEN
        RAISE EXCEPTION 'Contract needs its payment terms (billing_mode, currency, timezone): PR-1';
    END IF;
    -- PR-1: the timezone is an IANA zone (the server time zone database).
    IF NEW."payment_timezone" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z."name" = NEW."payment_timezone") THEN
        RAISE EXCEPTION 'Contract payment_timezone % is not an IANA time zone', NEW."payment_timezone";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "contract_payment_terms_guard" BEFORE INSERT ON "subscription"."Contract"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."guard_contract_payment_terms"();

-- ---------------------------------------------------------------------------------------
-- 2. ContractPaymentObligation
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."ContractPaymentObligation" (
    "id" UUID NOT NULL,
    -- N-3(b): the contract this obligation belongs to.
    "contract_id" UUID NOT NULL,
    "obligation_ref" TEXT NOT NULL,
    -- A calendar date in the contract's payment_timezone.
    "due_date" DATE NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    -- The SUBSCRIPTION_OPEN / SUBSCRIPTION_CHANGE (contract record or amendment) that recorded it.
    "recorded_by_change_request_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ContractPaymentObligation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ContractPaymentObligation_obligation_ref_check" CHECK ("obligation_ref" ~ '^[A-Z][A-Z0-9_-]{0,39}$'),
    CONSTRAINT "ContractPaymentObligation_amount_minor_check" CHECK ("amount_minor" >= 1),
    CONSTRAINT "ContractPaymentObligation_currency_check" CHECK ("currency" = 'USD'),
    CONSTRAINT "ContractPaymentObligation_description_check" CHECK (length("description") BETWEEN 1 AND 500),
    CONSTRAINT "ContractPaymentObligation_contract_id_fkey" FOREIGN KEY ("contract_id")
        REFERENCES "subscription"."Contract"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ContractPaymentObligation_recorded_by_change_request_id_fkey" FOREIGN KEY ("recorded_by_change_request_id")
        REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "ContractPaymentObligation_contract_id_obligation_ref_key" ON "subscription"."ContractPaymentObligation"("contract_id", "obligation_ref");

CREATE TRIGGER "contract_payment_obligation_no_update" BEFORE UPDATE ON "subscription"."ContractPaymentObligation"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."reject_contract_mutation"();
CREATE TRIGGER "contract_payment_obligation_no_delete" BEFORE DELETE ON "subscription"."ContractPaymentObligation"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."reject_contract_mutation"();

CREATE FUNCTION "subscription"."guard_contract_payment_obligation_insert"()
RETURNS TRIGGER AS $$
DECLARE
    cr RECORD;
    c RECORD;
BEGIN
    SELECT "state", "action_type", "tenant_id", "product_key" INTO cr
      FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."recorded_by_change_request_id";
    IF NOT FOUND OR cr."state" <> 'APPLYING' OR cr."action_type" NOT IN ('SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE') THEN
        RAISE EXCEPTION 'ContractPaymentObligation is recorded only by an applying SUBSCRIPTION_OPEN or SUBSCRIPTION_CHANGE request';
    END IF;
    SELECT k."billing_mode", k."payment_currency", s."tenant_id", s."product_key" INTO c
      FROM "subscription"."Contract" k JOIN "subscription"."TenantSubscription" s ON s."id" = k."tenant_subscription_id"
     WHERE k."id" = NEW."contract_id";
    IF NOT FOUND OR c."tenant_id" IS DISTINCT FROM cr."tenant_id" OR c."product_key" IS DISTINCT FROM cr."product_key" THEN
        RAISE EXCEPTION 'ContractPaymentObligation contract does not belong to the request tenant and product';
    END IF;
    IF c."billing_mode" IS NULL OR NEW."currency" IS DISTINCT FROM c."payment_currency" THEN
        RAISE EXCEPTION 'ContractPaymentObligation needs a contract with payment terms in the same currency';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "contract_payment_obligation_guard_insert" BEFORE INSERT ON "subscription"."ContractPaymentObligation"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."guard_contract_payment_obligation_insert"();

-- ---------------------------------------------------------------------------------------
-- 3. CommercialPaymentReceipt (§4.1)
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."CommercialPaymentReceipt" (
    "id" UUID NOT NULL,
    -- The governing PAYMENT_RECORD request (its authority, as CommercialChangeApplication's). One each.
    "change_request_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_key" TEXT NOT NULL,
    -- RECORD (operation RECORD) | CORRECTION (the replacement written by a CORRECT, PR-9).
    "entry_kind" TEXT NOT NULL,
    -- CORRECTION only: the receipt this one replaces.
    "corrects_receipt_id" UUID,
    -- Linkage (§4.3): NULL until linked; a non-INITIAL receipt is created linked.
    "contract_id" UUID,
    "obligation_id" UUID,
    "linked_at" TIMESTAMPTZ(3),
    "linked_by_change_request_id" UUID,
    -- §4.2 provisional identity (prepaid INITIAL recorded before its contract exists).
    "provisional_contract_ref" TEXT,
    "provisional_obligation_ref" TEXT,
    "provisional_amount_minor" BIGINT,
    "provisional_currency" TEXT,
    -- PR-5 evidence (immutable).
    "external_invoice_ref" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "received_on" DATE NOT NULL,
    "payment_method" TEXT NOT NULL,
    "payment_reference" TEXT NOT NULL,
    "verification" TEXT,
    "evidence_documents" JSONB NOT NULL,
    "origin" TEXT NOT NULL,
    -- PR-13: reserved for a future ACCT origin; unused (NULL) until a later amendment.
    "external_evidence_ref" TEXT,
    -- PR-9 supersession (derived status reads it; the record itself is never edited).
    "corrected_at" TIMESTAMPTZ(3),
    "corrected_by_change_request_id" UUID,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CommercialPaymentReceipt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CommercialPaymentReceipt_entry_kind_check" CHECK ("entry_kind" IN ('RECORD', 'CORRECTION')),
    CONSTRAINT "CommercialPaymentReceipt_corrects_check" CHECK (("entry_kind" = 'CORRECTION') = ("corrects_receipt_id" IS NOT NULL)),
    -- §4.1: linked_at IS NULL <=> (contract_id IS NULL AND obligation_id IS NULL).
    CONSTRAINT "CommercialPaymentReceipt_linkage_check" CHECK (
        ("linked_at" IS NULL) = ("contract_id" IS NULL) AND ("linked_at" IS NULL) = ("obligation_id" IS NULL)
        AND ("linked_at" IS NULL) = ("linked_by_change_request_id" IS NULL)),
    -- §4.1: the provisional fields are all present or all absent, and present only for INITIAL.
    CONSTRAINT "CommercialPaymentReceipt_provisional_check" CHECK (
        ("provisional_contract_ref" IS NULL) = ("provisional_obligation_ref" IS NULL)
        AND ("provisional_contract_ref" IS NULL) = ("provisional_amount_minor" IS NULL)
        AND ("provisional_contract_ref" IS NULL) = ("provisional_currency" IS NULL)
        AND ("provisional_obligation_ref" IS NULL OR "provisional_obligation_ref" = 'INITIAL')
        AND ("provisional_contract_ref" IS NULL OR "provisional_contract_ref" ~ '^[A-Z][A-Z0-9-]{2,39}$')
        AND ("provisional_amount_minor" IS NULL OR "provisional_amount_minor" >= 1)
        AND ("provisional_currency" IS NULL OR "provisional_currency" ~ '^[A-Z]{3}$')),
    -- §4.1: a receipt without the provisional identity is created already linked.
    CONSTRAINT "CommercialPaymentReceipt_unprovisional_linked_check" CHECK ("provisional_contract_ref" IS NOT NULL OR "linked_at" IS NOT NULL),
    CONSTRAINT "CommercialPaymentReceipt_amount_minor_check" CHECK ("amount_minor" >= 1),
    CONSTRAINT "CommercialPaymentReceipt_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "CommercialPaymentReceipt_external_invoice_ref_check" CHECK (length("external_invoice_ref") BETWEEN 1 AND 200),
    CONSTRAINT "CommercialPaymentReceipt_payment_reference_check" CHECK (length("payment_reference") BETWEEN 1 AND 200),
    CONSTRAINT "CommercialPaymentReceipt_payment_method_check" CHECK ("payment_method" IN ('BANK_TRANSFER', 'CHEQUE', 'CARD_EXTERNAL', 'OTHER')),
    -- PR-5: OTHER requires a non-empty explanation in verification.
    CONSTRAINT "CommercialPaymentReceipt_verification_check" CHECK (
        ("verification" IS NULL OR length("verification") BETWEEN 1 AND 2000)
        AND ("payment_method" <> 'OTHER' OR length(btrim(coalesce("verification", ''))) >= 1)),
    CONSTRAINT "CommercialPaymentReceipt_evidence_documents_check" CHECK ("subscription"."ccp_b4_valid_evidence_documents"("evidence_documents")),
    -- PR-5 / PR-13: MANUAL only; ACCT and external_evidence_ref are reserved.
    CONSTRAINT "CommercialPaymentReceipt_origin_check" CHECK ("origin" = 'MANUAL'),
    CONSTRAINT "CommercialPaymentReceipt_external_evidence_ref_check" CHECK ("external_evidence_ref" IS NULL),
    CONSTRAINT "CommercialPaymentReceipt_corrected_check" CHECK (("corrected_at" IS NULL) = ("corrected_by_change_request_id" IS NULL)),
    CONSTRAINT "CommercialPaymentReceipt_product_key_registry_check" CHECK ("product_key" IN ('sign')),
    CONSTRAINT "CommercialPaymentReceipt_change_request_id_fkey" FOREIGN KEY ("change_request_id")
        REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialPaymentReceipt_corrects_receipt_id_fkey" FOREIGN KEY ("corrects_receipt_id")
        REFERENCES "subscription"."CommercialPaymentReceipt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialPaymentReceipt_contract_id_fkey" FOREIGN KEY ("contract_id")
        REFERENCES "subscription"."Contract"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialPaymentReceipt_obligation_id_fkey" FOREIGN KEY ("obligation_id")
        REFERENCES "subscription"."ContractPaymentObligation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialPaymentReceipt_linked_by_change_request_id_fkey" FOREIGN KEY ("linked_by_change_request_id")
        REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "CommercialPaymentReceipt_corrected_by_change_request_id_fkey" FOREIGN KEY ("corrected_by_change_request_id")
        REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "CommercialPaymentReceipt_change_request_id_key" ON "subscription"."CommercialPaymentReceipt"("change_request_id");
-- PR-9: a receipt is replaced at most once.
CREATE UNIQUE INDEX "CommercialPaymentReceipt_corrects_receipt_id_key" ON "subscription"."CommercialPaymentReceipt"("corrects_receipt_id");
-- §4.2: at most one unlinked, uncorrected INITIAL receipt per (tenant, product, provisional_contract_ref).
CREATE UNIQUE INDEX "CommercialPaymentReceipt_one_unlinked_initial" ON "subscription"."CommercialPaymentReceipt"("tenant_id", "product_key", "provisional_contract_ref")
    WHERE "linked_at" IS NULL AND "corrected_at" IS NULL AND "provisional_contract_ref" IS NOT NULL;
-- PR-6: at most one effective (uncorrected) receipt per obligation.
CREATE UNIQUE INDEX "CommercialPaymentReceipt_one_effective_per_obligation" ON "subscription"."CommercialPaymentReceipt"("obligation_id")
    WHERE "corrected_at" IS NULL AND "obligation_id" IS NOT NULL;
-- PR-6: (tenant, external_invoice_ref, payment_reference) — the effective-row backstop; the service
-- refuses the triple against every receipt (PAYMENT_REFERENCE_DUPLICATE), a replacement excepted.
CREATE UNIQUE INDEX "CommercialPaymentReceipt_effective_reference_key" ON "subscription"."CommercialPaymentReceipt"("tenant_id", "external_invoice_ref", "payment_reference")
    WHERE "corrected_at" IS NULL;
CREATE INDEX "CommercialPaymentReceipt_contract_id_idx" ON "subscription"."CommercialPaymentReceipt"("contract_id");
CREATE INDEX "CommercialPaymentReceipt_tenant_id_product_key_idx" ON "subscription"."CommercialPaymentReceipt"("tenant_id", "product_key");

CREATE FUNCTION "subscription"."guard_commercial_payment_receipt"()
RETURNS TRIGGER AS $$
DECLARE
    cr RECORD;
    k RECORD;
    o RECORD;
    orig RECORD;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'CommercialPaymentReceipt is append-only (DELETE rejected)';
    END IF;
    IF TG_OP = 'INSERT' THEN
        -- Only the applying PAYMENT_RECORD request writes its receipt (no direct mutation).
        SELECT "state", "action_type", "tenant_id", "product_key", "requested_by", "payload" INTO cr
          FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."change_request_id";
        IF NOT FOUND OR cr."state" <> 'APPLYING' OR cr."action_type" <> 'PAYMENT_RECORD' THEN
            RAISE EXCEPTION 'CommercialPaymentReceipt is written only by an applying PAYMENT_RECORD request';
        END IF;
        IF NEW."tenant_id" IS DISTINCT FROM cr."tenant_id" OR NEW."product_key" IS DISTINCT FROM cr."product_key" THEN
            RAISE EXCEPTION 'CommercialPaymentReceipt does not belong to the request tenant and product';
        END IF;
        IF NEW."recorded_by" IS DISTINCT FROM cr."requested_by" THEN
            RAISE EXCEPTION 'CommercialPaymentReceipt recorded_by must be the requester';
        END IF;
        IF NEW."entry_kind" IS DISTINCT FROM (CASE cr."payload" ->> 'operation' WHEN 'RECORD' THEN 'RECORD' WHEN 'CORRECT' THEN 'CORRECTION' END) THEN
            RAISE EXCEPTION 'CommercialPaymentReceipt entry_kind must follow the request operation';
        END IF;
        IF NEW."corrected_at" IS NOT NULL THEN
            RAISE EXCEPTION 'CommercialPaymentReceipt is created uncorrected';
        END IF;
        IF NEW."entry_kind" = 'CORRECTION' THEN
            SELECT * INTO orig FROM "subscription"."CommercialPaymentReceipt" WHERE "id" = NEW."corrects_receipt_id";
            IF NOT FOUND OR orig."id"::text IS DISTINCT FROM cr."payload" ->> 'corrects_receipt_id'
               OR orig."tenant_id" <> NEW."tenant_id" OR orig."product_key" <> NEW."product_key" THEN
                RAISE EXCEPTION 'CommercialPaymentReceipt correction does not name the receipt its request corrects';
            END IF;
        END IF;
        IF NEW."linked_at" IS NOT NULL THEN
            -- Created linked: to an obligation of a contract of this tenant x product, by this request.
            IF NEW."linked_by_change_request_id" IS DISTINCT FROM NEW."change_request_id" THEN
                RAISE EXCEPTION 'CommercialPaymentReceipt created linked must be linked by its own request';
            END IF;
            SELECT s."tenant_id", s."product_key" INTO k
              FROM "subscription"."Contract" c JOIN "subscription"."TenantSubscription" s ON s."id" = c."tenant_subscription_id"
             WHERE c."id" = NEW."contract_id";
            SELECT * INTO o FROM "subscription"."ContractPaymentObligation" WHERE "id" = NEW."obligation_id";
            IF k."tenant_id" IS DISTINCT FROM NEW."tenant_id" OR k."product_key" IS DISTINCT FROM NEW."product_key"
               OR o."contract_id" IS DISTINCT FROM NEW."contract_id" THEN
                RAISE EXCEPTION 'CommercialPaymentReceipt linkage crosses tenant, product or contract';
            END IF;
        ELSIF EXISTS (SELECT 1 FROM "subscription"."Contract" c WHERE c."contract_ref" = NEW."provisional_contract_ref") THEN
            -- §4.2: the provisional ref must not be an existing contract's ref (globally unique).
            RAISE EXCEPTION 'CommercialPaymentReceipt provisional_contract_ref % is taken by a contract (CONTRACT_REF_TAKEN)', NEW."provisional_contract_ref";
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE: the evidence and identity never change.
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."change_request_id" IS DISTINCT FROM OLD."change_request_id"
       OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR NEW."product_key" IS DISTINCT FROM OLD."product_key"
       OR NEW."entry_kind" IS DISTINCT FROM OLD."entry_kind" OR NEW."corrects_receipt_id" IS DISTINCT FROM OLD."corrects_receipt_id"
       OR NEW."provisional_contract_ref" IS DISTINCT FROM OLD."provisional_contract_ref"
       OR NEW."provisional_obligation_ref" IS DISTINCT FROM OLD."provisional_obligation_ref"
       OR NEW."provisional_amount_minor" IS DISTINCT FROM OLD."provisional_amount_minor"
       OR NEW."provisional_currency" IS DISTINCT FROM OLD."provisional_currency"
       OR NEW."external_invoice_ref" IS DISTINCT FROM OLD."external_invoice_ref" OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
       OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."received_on" IS DISTINCT FROM OLD."received_on"
       OR NEW."payment_method" IS DISTINCT FROM OLD."payment_method" OR NEW."payment_reference" IS DISTINCT FROM OLD."payment_reference"
       OR NEW."verification" IS DISTINCT FROM OLD."verification" OR NEW."evidence_documents" IS DISTINCT FROM OLD."evidence_documents"
       OR NEW."origin" IS DISTINCT FROM OLD."origin" OR NEW."external_evidence_ref" IS DISTINCT FROM OLD."external_evidence_ref"
       OR NEW."recorded_by" IS DISTINCT FROM OLD."recorded_by" OR NEW."recorded_at" IS DISTINCT FROM OLD."recorded_at" THEN
        RAISE EXCEPTION 'CommercialPaymentReceipt is append-only (its evidence and identity are immutable)';
    END IF;

    IF OLD."linked_at" IS NULL AND NEW."linked_at" IS NOT NULL
       AND NEW."corrected_at" IS NOT DISTINCT FROM OLD."corrected_at"
       AND NEW."corrected_by_change_request_id" IS NOT DISTINCT FROM OLD."corrected_by_change_request_id" THEN
        -- (a) §4.3 step 6: the link, inside the applying SUBSCRIPTION_OPEN of the same tenant x product,
        -- to the contract it recorded (ref = provisional_contract_ref) and that contract's INITIAL obligation
        -- (amount and currency = the provisional ones).
        IF OLD."corrected_at" IS NOT NULL THEN
            RAISE EXCEPTION 'CommercialPaymentReceipt: a corrected receipt is never linked';
        END IF;
        SELECT "state", "action_type", "tenant_id", "product_key" INTO cr
          FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."linked_by_change_request_id";
        IF NOT FOUND OR cr."state" <> 'APPLYING' OR cr."action_type" <> 'SUBSCRIPTION_OPEN' THEN
            RAISE EXCEPTION 'CommercialPaymentReceipt is linked only by an applying SUBSCRIPTION_OPEN request';
        END IF;
        SELECT c."contract_ref", c."recorded_by_change_request_id", c."payment_currency", s."tenant_id", s."product_key" INTO k
          FROM "subscription"."Contract" c JOIN "subscription"."TenantSubscription" s ON s."id" = c."tenant_subscription_id"
         WHERE c."id" = NEW."contract_id";
        IF NOT FOUND OR cr."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR cr."product_key" IS DISTINCT FROM OLD."product_key"
           OR k."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR k."product_key" IS DISTINCT FROM OLD."product_key" THEN
            RAISE EXCEPTION 'CommercialPaymentReceipt link refused: the contract or request belongs to another tenant or product';
        END IF;
        IF k."contract_ref" IS DISTINCT FROM OLD."provisional_contract_ref" OR k."recorded_by_change_request_id" IS DISTINCT FROM NEW."linked_by_change_request_id" THEN
            RAISE EXCEPTION 'CommercialPaymentReceipt link refused: the contract is not the one its provisional ref names';
        END IF;
        SELECT * INTO o FROM "subscription"."ContractPaymentObligation" WHERE "id" = NEW."obligation_id";
        IF NOT FOUND OR o."contract_id" IS DISTINCT FROM NEW."contract_id" OR o."obligation_ref" IS DISTINCT FROM OLD."provisional_obligation_ref"
           OR o."amount_minor" IS DISTINCT FROM OLD."provisional_amount_minor" OR o."currency" IS DISTINCT FROM OLD."provisional_currency"
           OR o."amount_minor" IS DISTINCT FROM OLD."amount_minor" OR o."currency" IS DISTINCT FROM OLD."currency" THEN
            RAISE EXCEPTION 'CommercialPaymentReceipt link refused: the obligation does not match the provisional INITIAL identity';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."corrected_at" IS NULL AND NEW."corrected_at" IS NOT NULL
       AND NEW."linked_at" IS NOT DISTINCT FROM OLD."linked_at" AND NEW."contract_id" IS NOT DISTINCT FROM OLD."contract_id"
       AND NEW."obligation_id" IS NOT DISTINCT FROM OLD."obligation_id"
       AND NEW."linked_by_change_request_id" IS NOT DISTINCT FROM OLD."linked_by_change_request_id" THEN
        -- (b) PR-9: superseded by the applying CORRECT that names this receipt.
        SELECT "state", "action_type", "tenant_id", "product_key", "payload" INTO cr
          FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."corrected_by_change_request_id";
        IF NOT FOUND OR cr."state" <> 'APPLYING' OR cr."action_type" <> 'PAYMENT_RECORD' OR cr."payload" ->> 'operation' <> 'CORRECT'
           OR cr."payload" ->> 'corrects_receipt_id' IS DISTINCT FROM OLD."id"::text
           OR cr."tenant_id" IS DISTINCT FROM OLD."tenant_id" OR cr."product_key" IS DISTINCT FROM OLD."product_key" THEN
            RAISE EXCEPTION 'CommercialPaymentReceipt is superseded only by the applying CORRECT that names it';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'CommercialPaymentReceipt is append-only (only the link and the correction mark are set, once)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "commercial_payment_receipt_guard" BEFORE INSERT OR UPDATE OR DELETE ON "subscription"."CommercialPaymentReceipt"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."guard_commercial_payment_receipt"();

-- ---------------------------------------------------------------------------------------
-- 4. PAYMENT_RECORD never commits in APPLYING (the apply is one transaction; PR-4)
-- ---------------------------------------------------------------------------------------
CREATE CONSTRAINT TRIGGER "commercial_change_request_no_applying_commit_c8pr"
    AFTER UPDATE ON "subscription"."CommercialChangeRequest"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW."state" = 'APPLYING' AND NEW."action_type" = 'PAYMENT_RECORD')
    EXECUTE FUNCTION "subscription"."guard_commercial_change_request_not_applying"();
