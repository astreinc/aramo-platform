-- CCP-C8-PR — compensating SQL for 20261030010000_ccp_c8pr_payment_record. NOT a forward migration.
-- Refused (RAISE, nothing changed) while any PAYMENT_RECORD request, payment receipt, payment obligation or
-- contract with payment terms exists: receipts are commercial attestations and are never deleted (§4.3
-- step 5), so the compensation is valid only on a chain that never recorded one. It then drops, in reverse
-- order, the deferred PAYMENT_RECORD backstop, the receipt table and its guard, the obligation table and
-- its guard, and the five Contract payment-terms columns with their CHECKs and insert trigger.
-- The CCP-C8-PR blocks of the integrator union files (guard, constraint, alert type) are compensated with
-- those files (their own compensating SQL), after this one. Production execution needs separate PO
-- authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."CommercialChangeRequest" WHERE "action_type" = 'PAYMENT_RECORD')
     OR EXISTS (SELECT 1 FROM "subscription"."CommercialPaymentReceipt")
     OR EXISTS (SELECT 1 FROM "subscription"."ContractPaymentObligation")
     OR EXISTS (SELECT 1 FROM "subscription"."Contract" WHERE "billing_mode" IS NOT NULL) THEN
    RAISE EXCEPTION 'CCP-C8-PR compensation refused: a PAYMENT_RECORD request, a payment receipt, an obligation or a contract with payment terms exists';
  END IF;
END
$$;
DROP TRIGGER "commercial_change_request_no_applying_commit_c8pr" ON "subscription"."CommercialChangeRequest";
DROP TABLE "subscription"."CommercialPaymentReceipt";
DROP FUNCTION "subscription"."guard_commercial_payment_receipt"();
DROP TABLE "subscription"."ContractPaymentObligation";
DROP FUNCTION "subscription"."guard_contract_payment_obligation_insert"();
DROP TRIGGER "contract_payment_terms_guard" ON "subscription"."Contract";
DROP FUNCTION "subscription"."guard_contract_payment_terms"();
ALTER TABLE "subscription"."Contract"
    DROP CONSTRAINT "Contract_billing_mode_check",
    DROP CONSTRAINT "Contract_payment_terms_all_or_none_check",
    DROP CONSTRAINT "Contract_payment_currency_check",
    DROP CONSTRAINT "Contract_payment_timezone_check",
    DROP CONSTRAINT "Contract_grace_days_check",
    DROP CONSTRAINT "Contract_postpaid_approval_check",
    DROP COLUMN "billing_mode",
    DROP COLUMN "payment_currency",
    DROP COLUMN "payment_timezone",
    DROP COLUMN "grace_days",
    DROP COLUMN "postpaid_approval";
