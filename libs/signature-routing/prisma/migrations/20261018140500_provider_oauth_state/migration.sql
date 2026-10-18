-- Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-v1_0-LOCKED §G
-- OAuth connect state for external e-signature providers: single-use, expiring,
-- bound to the tenant, the admin who started the connect, and the provider. Only
-- a SHA-256 of the state value is stored; the PKCE verifier never leaves the server.
CREATE TABLE "signature_routing"."ProviderOAuthState" (
    "state_hash" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "code_verifier" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    CONSTRAINT "ProviderOAuthState_pkey" PRIMARY KEY ("state_hash"),
    CONSTRAINT "ProviderOAuthState_provider_check" CHECK ("provider" IN ('docusign', 'adobe_sign'))
);
CREATE INDEX "ProviderOAuthState_expires_at_idx" ON "signature_routing"."ProviderOAuthState"("expires_at");
CREATE INDEX "SignatureRequestRoute_provider_provider_envelope_ref_idx"
    ON "signature_routing"."SignatureRequestRoute"("provider", "provider_envelope_ref");
