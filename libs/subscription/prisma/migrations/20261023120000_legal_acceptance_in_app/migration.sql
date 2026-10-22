-- Aramo Sign Personal (Free) — in-app acceptance of a newer APPROVED legal-document
-- version by a signed-in Personal account (re-acceptance before sending).
-- Additive only. splitDdl-safe: no semicolons in comment lines.
--
-- 1. LegalAcceptance.context admits IN_APP. Existing values are unchanged.
ALTER TABLE "subscription"."LegalAcceptance" DROP CONSTRAINT "LegalAcceptance_context_check";
ALTER TABLE "subscription"."LegalAcceptance"
    ADD CONSTRAINT "LegalAcceptance_context_check"
    CHECK ("context" IN ('SIGNUP', 'CHECKOUT', 'IN_APP'));

-- 2. Where an in-app acceptance came from (client IP and user agent), kept beside
--    the acceptance in a NEW table so the LegalAcceptance row shape is unchanged
--    (signup keeps its IP on the signup request, checkout on its checkout intent).
CREATE TABLE "subscription"."LegalAcceptanceOrigin" (
    "acceptance_id" UUID NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LegalAcceptanceOrigin_pkey" PRIMARY KEY ("acceptance_id"),
    CONSTRAINT "LegalAcceptanceOrigin_acceptance_id_fkey" FOREIGN KEY ("acceptance_id") REFERENCES "subscription"."LegalAcceptance"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- 3. The status read: a user's acceptances in a tenant.
CREATE INDEX "LegalAcceptance_tenant_id_user_id_document_key_idx"
    ON "subscription"."LegalAcceptance"("tenant_id", "user_id", "document_key");
