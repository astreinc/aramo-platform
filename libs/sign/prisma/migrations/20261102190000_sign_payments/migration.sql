-- Aramo Sign 1.14 — payment collection through Stripe Connect.
-- Governing: Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED (2bd74ca5) §1.14, §4 R-6,
-- §5 D-3, and Amendment A1 (dc95b283) A1.1 (built now, behind a vendor-neutral port, dark).
-- ADDITIVE ONLY. Aramo never holds subscriber funds: a payment is a direct charge on the
-- subscriber's own connected Stripe account, collected on a Stripe-hosted page. No card data
-- is stored here, only Stripe object references and amounts.
-- splitDdl-safe: no semicolons in comment lines.
--
--   SignatureField   PAYMENT field type, with payment_amount_minor and payment_currency
--                    (present exactly for PAYMENT, USD only). The field value is filled by
--                    the server once the payment succeeds (a signer never fills it).
--   SignPaymentAccount       one row per tenant: the connected account and its status.
--   SignPayment              one row per PAYMENT field: amount, status, Stripe references.
--   SignPaymentRefund        refunds requested from the sender console.
--   SignPaymentWebhookEvent  verified Connect webhook events, processed at most once.

-- 1. PAYMENT field type and its configuration.
ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_type_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_type_check"
  CHECK ("field_type" IN ('SIGNATURE', 'INITIALS', 'SIGN_DATE', 'SIGNER_NAME', 'TEXT', 'CHECKBOX', 'ACKNOWLEDGEMENT', 'PAYMENT'));

ALTER TABLE "sign"."SignatureField" ADD COLUMN "payment_amount_minor" INTEGER;
ALTER TABLE "sign"."SignatureField" ADD COLUMN "payment_currency" TEXT;

-- Present exactly for PAYMENT. USD only (directive §4: no other currencies). Amount in
-- cents, from 50 (the Stripe minimum charge) to 99999999.
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_payment_config_check"
  CHECK (
    ("field_type" = 'PAYMENT' AND "payment_amount_minor" IS NOT NULL AND "payment_currency" IS NOT NULL
      AND "payment_amount_minor" BETWEEN 50 AND 99999999 AND "payment_currency" = 'USD')
    OR ("field_type" <> 'PAYMENT' AND "payment_amount_minor" IS NULL AND "payment_currency" IS NULL)
  );

-- 2. The tenant's connected account (Stripe Standard account owned by the subscriber).
CREATE TABLE "sign"."SignPaymentAccount" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'STRIPE_CONNECT',
  "account_ref" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "charges_enabled" BOOLEAN NOT NULL DEFAULT false,
  "details_submitted" BOOLEAN NOT NULL DEFAULT false,
  "payouts_enabled" BOOLEAN NOT NULL DEFAULT false,
  "live" BOOLEAN NOT NULL DEFAULT false,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disconnected_at" TIMESTAMPTZ,
  "disconnected_by" UUID,
  CONSTRAINT "SignPaymentAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignPaymentAccount_provider_check" CHECK ("provider" IN ('STRIPE_CONNECT')),
  CONSTRAINT "SignPaymentAccount_status_check" CHECK ("status" IN ('CONNECTED', 'DISCONNECTED')),
  CONSTRAINT "SignPaymentAccount_disconnected_check" CHECK (
    ("status" = 'DISCONNECTED' AND "disconnected_at" IS NOT NULL)
    OR ("status" = 'CONNECTED' AND "disconnected_at" IS NULL)
  )
);
CREATE UNIQUE INDEX "SignPaymentAccount_tenant_key" ON "sign"."SignPaymentAccount" ("tenant_id");
CREATE UNIQUE INDEX "SignPaymentAccount_account_ref_key" ON "sign"."SignPaymentAccount" ("account_ref");

-- 3. One payment per PAYMENT field (a signer pays it once). account_ref is copied so a
-- refund of an earlier payment still goes to the account that collected it.
CREATE TABLE "sign"."SignPayment" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "envelope_id" UUID NOT NULL,
  "signer_id" UUID NOT NULL,
  "field_id" UUID NOT NULL,
  "account_ref" TEXT NOT NULL,
  "amount_minor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "application_fee_minor" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL,
  "checkout_ref" TEXT,
  "payment_ref" TEXT,
  "amount_refunded_minor" INTEGER NOT NULL DEFAULT 0,
  "live" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paid_at" TIMESTAMPTZ,
  CONSTRAINT "SignPayment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignPayment_status_check" CHECK ("status" IN ('PENDING', 'PAID', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED')),
  CONSTRAINT "SignPayment_currency_check" CHECK ("currency" = 'USD'),
  CONSTRAINT "SignPayment_amount_check" CHECK ("amount_minor" BETWEEN 50 AND 99999999),
  CONSTRAINT "SignPayment_fee_check" CHECK ("application_fee_minor" >= 0 AND "application_fee_minor" < "amount_minor"),
  CONSTRAINT "SignPayment_refunded_check" CHECK ("amount_refunded_minor" >= 0 AND "amount_refunded_minor" <= "amount_minor"),
  CONSTRAINT "SignPayment_paid_check" CHECK ("status" IN ('PENDING', 'FAILED') OR ("paid_at" IS NOT NULL AND "payment_ref" IS NOT NULL))
);
CREATE UNIQUE INDEX "SignPayment_field_key" ON "sign"."SignPayment" ("field_id");
CREATE UNIQUE INDEX "SignPayment_checkout_ref_key" ON "sign"."SignPayment" ("checkout_ref");
CREATE UNIQUE INDEX "SignPayment_payment_ref_key" ON "sign"."SignPayment" ("payment_ref");
CREATE INDEX "SignPayment_tenant_envelope_idx" ON "sign"."SignPayment" ("tenant_id", "envelope_id");

-- 4. Refunds requested from the sender console (through Stripe, on the connected account).
CREATE TABLE "sign"."SignPaymentRefund" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "amount_minor" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "refund_ref" TEXT,
  "reason" TEXT,
  "requested_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SignPaymentRefund_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignPaymentRefund_status_check" CHECK ("status" IN ('REQUESTED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED')),
  CONSTRAINT "SignPaymentRefund_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "SignPaymentRefund_reason_check" CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "SignPaymentRefund_payment_fkey" FOREIGN KEY ("payment_id") REFERENCES "sign"."SignPayment" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "SignPaymentRefund_refund_ref_key" ON "sign"."SignPaymentRefund" ("refund_ref");
CREATE INDEX "SignPaymentRefund_payment_idx" ON "sign"."SignPaymentRefund" ("payment_id");

-- 5. Verified Connect webhook events (the event id makes each one processed at most once).
CREATE TABLE "sign"."SignPaymentWebhookEvent" (
  "event_ref" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "account_ref" TEXT,
  "outcome" TEXT,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ,
  CONSTRAINT "SignPaymentWebhookEvent_pkey" PRIMARY KEY ("event_ref"),
  CONSTRAINT "SignPaymentWebhookEvent_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('APPLIED', 'IGNORED', 'FAILED'))
);
