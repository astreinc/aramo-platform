-- Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-v1_0-LOCKED §D/§E
-- Tenant e-signature provider selection, its audit trail, and per-request routes.
-- Additive only. No tenant row is written: absence means the built-in Aramo Sign.

CREATE SCHEMA IF NOT EXISTS "signature_routing";

CREATE TABLE "signature_routing"."TenantSignatureProvider" (
    "tenant_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "selected_by" TEXT NOT NULL,
    "selected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TenantSignatureProvider_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "TenantSignatureProvider_provider_check" CHECK ("provider" IN ('aramo_sign', 'docusign', 'adobe_sign'))
);

CREATE TABLE "signature_routing"."SignatureProviderSelectionEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "from_provider" TEXT NOT NULL,
    "to_provider" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignatureProviderSelectionEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SignatureProviderSelectionEvent_tenant_id_occurred_at_idx"
    ON "signature_routing"."SignatureProviderSelectionEvent"("tenant_id", "occurred_at");

-- Audit rows are append-only.
CREATE FUNCTION "signature_routing".reject_selection_event_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SignatureProviderSelectionEvent is append-only';
END;
$$;
CREATE TRIGGER "SignatureProviderSelectionEvent_append_only"
    BEFORE UPDATE OR DELETE ON "signature_routing"."SignatureProviderSelectionEvent"
    FOR EACH ROW EXECUTE FUNCTION "signature_routing".reject_selection_event_change();

CREATE TABLE "signature_routing"."SignatureRequestRoute" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_revision_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_envelope_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignatureRequestRoute_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SignatureRequestRoute_provider_check" CHECK ("provider" IN ('aramo_sign', 'docusign', 'adobe_sign'))
);
CREATE UNIQUE INDEX "SignatureRequestRoute_tenant_id_provider_provider_envelope_ref_key"
    ON "signature_routing"."SignatureRequestRoute"("tenant_id", "provider", "provider_envelope_ref");
CREATE INDEX "SignatureRequestRoute_tenant_id_document_id_document_revision_id_idx"
    ON "signature_routing"."SignatureRequestRoute"("tenant_id", "document_id", "document_revision_id");
