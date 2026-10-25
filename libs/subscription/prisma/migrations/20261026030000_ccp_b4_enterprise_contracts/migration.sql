-- CCP-B4 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.3 row B4; MP-A2 N-2, N-3, N-4;
-- Charter L6; Conversion Rule §3.1 definition (b), O-5) — enterprise contract records.
--
-- A contract is an evidence-bearing record of a governed MANUAL subscription: negotiated
-- terms and hashed evidence documents. It is NOT a subscription, an entitlement or a ledger:
--   N-3(a) both tables live in the subscription schema;
--   N-3(b) Contract references the TenantSubscription it governs (FK, NOT NULL, RESTRICT);
--          ContractAmendment references its Contract; both reference the governing
--          CommercialChangeRequest;
--   N-3(c) no plan, version, product, allowance or commitment column: those are read
--          through TenantSubscription (and its pinned PlanVersion) only;
--   N-3(d) no open/closed state and no usage column: Active / Ended is the referenced
--          subscription's ended_at; usage stays in AllowanceUsage.
--
-- ADDITIVE ONLY. No existing table, column, index, function or row changes. In particular
-- guard_commercial_change_request() (migration 20261025200000) is NOT replaced: contract rows
-- ride the existing A6 actions (SUBSCRIPTION_OPEN / _CHANGE / _END) and are written inside the
-- A6 apply transaction. The insert guards below refuse any contract row that is not written
-- by a change request in APPLYING of the matching action and tenant (no direct mutation,
-- PBD §5.3 common HALT). Both tables are append-only (UPDATE / DELETE raise).
--
-- Evidence documents are METADATA ONLY (name, sha256, optional byte size and media type):
-- no file bytes are stored (TD-B4-1, doc/ccp/slices/CCP-B4-acceptance.md).
--
-- Carries dollar-quoted function bodies: any spec applying this migration MUST use a
-- whole-file DDL applier (pg Client), never a line splitter.
--
-- Compensating migration (documented, not shipped; CCP-B4-acceptance.md §6): RAISE if any
-- Contract row exists; then drop both tables, their trigger functions and the two
-- validators. Design approval is not production migration authority (ruling A0-C15).

-- ---------------------------------------------------------------------------------------
-- 1. Validators (IMMUTABLE; used by CHECK constraints)
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION "subscription"."ccp_b4_valid_terms"(t JSONB)
RETURNS BOOLEAN AS $$
DECLARE
    e JSONB;
BEGIN
    IF t IS NULL OR jsonb_typeof(t) <> 'array' OR jsonb_array_length(t) < 1 OR jsonb_array_length(t) > 50 THEN
        RETURN FALSE;
    END IF;
    FOR e IN SELECT * FROM jsonb_array_elements(t) LOOP
        IF jsonb_typeof(e) <> 'string' OR length(e #>> '{}') < 1 OR length(e #>> '{}') > 500 THEN
            RETURN FALSE;
        END IF;
    END LOOP;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION "subscription"."ccp_b4_valid_evidence_documents"(d JSONB)
RETURNS BOOLEAN AS $$
DECLARE
    e JSONB;
    k TEXT;
BEGIN
    IF d IS NULL OR jsonb_typeof(d) <> 'array' OR jsonb_array_length(d) > 20 THEN
        RETURN FALSE;
    END IF;
    FOR e IN SELECT * FROM jsonb_array_elements(d) LOOP
        IF jsonb_typeof(e) <> 'object' THEN
            RETURN FALSE;
        END IF;
        FOR k IN SELECT * FROM jsonb_object_keys(e) LOOP
            IF k NOT IN ('name', 'sha256', 'byte_size', 'media_type') THEN
                RETURN FALSE;
            END IF;
        END LOOP;
        IF jsonb_typeof(e -> 'name') IS DISTINCT FROM 'string' OR length(e ->> 'name') < 1 OR length(e ->> 'name') > 200 THEN
            RETURN FALSE;
        END IF;
        IF jsonb_typeof(e -> 'sha256') IS DISTINCT FROM 'string' OR (e ->> 'sha256') !~ '^[0-9a-f]{64}$' THEN
            RETURN FALSE;
        END IF;
        IF e ? 'byte_size' AND (jsonb_typeof(e -> 'byte_size') <> 'number' OR (e ->> 'byte_size') !~ '^[0-9]{1,15}$') THEN
            RETURN FALSE;
        END IF;
        IF e ? 'media_type' AND (jsonb_typeof(e -> 'media_type') <> 'string' OR length(e ->> 'media_type') < 1 OR length(e ->> 'media_type') > 100) THEN
            RETURN FALSE;
        END IF;
    END LOOP;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------------------
-- 2. Contract
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."Contract" (
    "id" UUID NOT NULL,
    -- The human contract reference (e.g. CT-2026-021). Unique across the platform.
    "contract_ref" TEXT NOT NULL,
    -- N-3(b): the governed subscription row this contract governs.
    "tenant_subscription_id" UUID NOT NULL,
    -- The negotiated terms AS RECORDED (evidence text; never read by any resolver).
    "terms" JSONB NOT NULL,
    -- Hashed evidence documents (metadata only).
    "evidence_documents" JSONB NOT NULL,
    -- Free-text evidence reference (ticket, call notes) from the request.
    "evidence_ref" TEXT,
    -- CHANGE_REQUEST | MIGRATION (= the recording request's kind).
    "provenance" TEXT NOT NULL,
    "recorded_by_change_request_id" UUID NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Contract_contract_ref_check" CHECK ("contract_ref" ~ '^[A-Z][A-Z0-9-]{2,39}$'),
    CONSTRAINT "Contract_terms_check" CHECK ("subscription"."ccp_b4_valid_terms"("terms")),
    CONSTRAINT "Contract_evidence_documents_check" CHECK ("subscription"."ccp_b4_valid_evidence_documents"("evidence_documents")),
    CONSTRAINT "Contract_evidence_ref_check" CHECK ("evidence_ref" IS NULL OR length("evidence_ref") BETWEEN 1 AND 500),
    CONSTRAINT "Contract_provenance_check" CHECK ("provenance" IN ('CHANGE_REQUEST', 'MIGRATION')),
    CONSTRAINT "Contract_tenant_subscription_id_fkey" FOREIGN KEY ("tenant_subscription_id")
        REFERENCES "subscription"."TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "Contract_recorded_by_change_request_id_fkey" FOREIGN KEY ("recorded_by_change_request_id")
        REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "Contract_contract_ref_key" ON "subscription"."Contract"("contract_ref");
-- One contract per governed subscription row.
CREATE UNIQUE INDEX "Contract_tenant_subscription_id_key" ON "subscription"."Contract"("tenant_subscription_id");
CREATE UNIQUE INDEX "Contract_recorded_by_change_request_id_key" ON "subscription"."Contract"("recorded_by_change_request_id");
CREATE INDEX "Contract_recorded_at_id_idx" ON "subscription"."Contract"("recorded_at" DESC, "id" DESC);

-- ---------------------------------------------------------------------------------------
-- 3. ContractAmendment
-- ---------------------------------------------------------------------------------------
CREATE TABLE "subscription"."ContractAmendment" (
    "id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    -- 1, 2, 3 … per contract (gap-free; checked on insert).
    "sequence" INTEGER NOT NULL,
    -- AMENDMENT (a SUBSCRIPTION_CHANGE) | END (the evidence of a SUBSCRIPTION_END). END is
    -- evidence of the end, not a state: Active / Ended is read from the subscription row.
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    -- The full negotiated terms after an AMENDMENT; NULL = unchanged. Always NULL for END.
    "terms" JSONB,
    "evidence_documents" JSONB NOT NULL,
    "evidence_ref" TEXT,
    "change_request_id" UUID NOT NULL,
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ContractAmendment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ContractAmendment_sequence_check" CHECK ("sequence" >= 1),
    CONSTRAINT "ContractAmendment_kind_check" CHECK ("kind" IN ('AMENDMENT', 'END')),
    CONSTRAINT "ContractAmendment_summary_check" CHECK (length("summary") BETWEEN 1 AND 500),
    CONSTRAINT "ContractAmendment_terms_check" CHECK (
        ("terms" IS NULL) OR ("kind" = 'AMENDMENT' AND "subscription"."ccp_b4_valid_terms"("terms"))),
    CONSTRAINT "ContractAmendment_evidence_documents_check" CHECK ("subscription"."ccp_b4_valid_evidence_documents"("evidence_documents")),
    CONSTRAINT "ContractAmendment_evidence_ref_check" CHECK ("evidence_ref" IS NULL OR length("evidence_ref") BETWEEN 1 AND 500),
    CONSTRAINT "ContractAmendment_contract_id_fkey" FOREIGN KEY ("contract_id")
        REFERENCES "subscription"."Contract"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ContractAmendment_change_request_id_fkey" FOREIGN KEY ("change_request_id")
        REFERENCES "subscription"."CommercialChangeRequest"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "ContractAmendment_contract_id_sequence_key" ON "subscription"."ContractAmendment"("contract_id", "sequence");
CREATE UNIQUE INDEX "ContractAmendment_change_request_id_key" ON "subscription"."ContractAmendment"("change_request_id");

-- ---------------------------------------------------------------------------------------
-- 4. Append-only
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION "subscription"."reject_contract_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "contract_no_update" BEFORE UPDATE ON "subscription"."Contract"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."reject_contract_mutation"();
CREATE TRIGGER "contract_no_delete" BEFORE DELETE ON "subscription"."Contract"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."reject_contract_mutation"();
CREATE TRIGGER "contract_amendment_no_update" BEFORE UPDATE ON "subscription"."ContractAmendment"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."reject_contract_mutation"();
CREATE TRIGGER "contract_amendment_no_delete" BEFORE DELETE ON "subscription"."ContractAmendment"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."reject_contract_mutation"();

-- ---------------------------------------------------------------------------------------
-- 5. Insert guards: only an applying change request of the matching action writes a row
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION "subscription"."guard_contract_insert"()
RETURNS TRIGGER AS $$
DECLARE
    cr RECORD;
    sub RECORD;
BEGIN
    SELECT "state", "action_type", "kind", "tenant_id", "product_key", "requested_by" INTO cr
      FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."recorded_by_change_request_id";
    IF NOT FOUND OR cr."state" <> 'APPLYING' OR cr."action_type" NOT IN ('SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE') THEN
        RAISE EXCEPTION 'Contract is recorded only by an applying SUBSCRIPTION_OPEN or SUBSCRIPTION_CHANGE request';
    END IF;
    SELECT "tenant_id", "product_key", "source", "composition_role", "ended_at", "billing_subscription_ref" INTO sub
      FROM "subscription"."TenantSubscription" WHERE "id" = NEW."tenant_subscription_id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Contract references no subscription';
    END IF;
    -- Conversion Rule §3.1 (b) ⊆ (a): a contract governs only an open MANUAL BASE row that the
    -- provider does not own.
    IF sub."ended_at" IS NOT NULL OR sub."source" <> 'MANUAL' OR sub."composition_role" <> 'BASE' OR sub."billing_subscription_ref" IS NOT NULL THEN
        RAISE EXCEPTION 'Contract may reference only an open MANUAL BASE subscription with no provider link';
    END IF;
    IF sub."tenant_id" IS DISTINCT FROM cr."tenant_id" OR sub."product_key" IS DISTINCT FROM cr."product_key" THEN
        RAISE EXCEPTION 'Contract subscription does not belong to the request tenant and product';
    END IF;
    IF NEW."recorded_by" IS DISTINCT FROM cr."requested_by" THEN
        RAISE EXCEPTION 'Contract recorded_by must be the requester';
    END IF;
    IF NEW."provenance" IS DISTINCT FROM (CASE WHEN cr."kind" = 'MIGRATION' THEN 'MIGRATION' ELSE 'CHANGE_REQUEST' END) THEN
        RAISE EXCEPTION 'Contract provenance must follow the request kind';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "contract_guard_insert" BEFORE INSERT ON "subscription"."Contract"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."guard_contract_insert"();

CREATE FUNCTION "subscription"."guard_contract_amendment_insert"()
RETURNS TRIGGER AS $$
DECLARE
    cr RECORD;
    sub RECORD;
    last_seq INTEGER;
BEGIN
    SELECT "state", "action_type", "tenant_id", "product_key", "requested_by" INTO cr
      FROM "subscription"."CommercialChangeRequest" WHERE "id" = NEW."change_request_id";
    IF NOT FOUND OR cr."state" <> 'APPLYING' THEN
        RAISE EXCEPTION 'ContractAmendment is recorded only by an applying change request';
    END IF;
    IF (NEW."kind" = 'AMENDMENT' AND cr."action_type" <> 'SUBSCRIPTION_CHANGE') OR (NEW."kind" = 'END' AND cr."action_type" <> 'SUBSCRIPTION_END') THEN
        RAISE EXCEPTION 'ContractAmendment % needs a % request (got %)', NEW."kind",
            CASE WHEN NEW."kind" = 'END' THEN 'SUBSCRIPTION_END' ELSE 'SUBSCRIPTION_CHANGE' END, cr."action_type";
    END IF;
    SELECT s."tenant_id", s."product_key", s."ended_at" INTO sub
      FROM "subscription"."Contract" c JOIN "subscription"."TenantSubscription" s ON s."id" = c."tenant_subscription_id"
     WHERE c."id" = NEW."contract_id";
    IF NOT FOUND OR sub."tenant_id" IS DISTINCT FROM cr."tenant_id" OR sub."product_key" IS DISTINCT FROM cr."product_key" THEN
        RAISE EXCEPTION 'ContractAmendment contract does not belong to the request tenant and product';
    END IF;
    -- The state is the subscription's: an amendment needs it open; an end needs it ended in
    -- the same transaction (the A6 SUBSCRIPTION_END write precedes this insert).
    IF NEW."kind" = 'AMENDMENT' AND sub."ended_at" IS NOT NULL THEN
        RAISE EXCEPTION 'ContractAmendment: the contract subscription has ended';
    END IF;
    IF NEW."kind" = 'END' AND sub."ended_at" IS NULL THEN
        RAISE EXCEPTION 'ContractAmendment END: the contract subscription is still open';
    END IF;
    IF NEW."recorded_by" IS DISTINCT FROM cr."requested_by" THEN
        RAISE EXCEPTION 'ContractAmendment recorded_by must be the requester';
    END IF;
    SELECT COALESCE(max("sequence"), 0) INTO last_seq FROM "subscription"."ContractAmendment" WHERE "contract_id" = NEW."contract_id";
    IF NEW."sequence" <> last_seq + 1 THEN
        RAISE EXCEPTION 'ContractAmendment sequence must be % (got %)', last_seq + 1, NEW."sequence";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "contract_amendment_guard_insert" BEFORE INSERT ON "subscription"."ContractAmendment"
    FOR EACH ROW EXECUTE FUNCTION "subscription"."guard_contract_amendment_insert"();
