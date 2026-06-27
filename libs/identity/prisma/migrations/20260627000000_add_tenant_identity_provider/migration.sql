-- Subdomain-Identity Directive B — Home Realm Discovery: Tenant.identity_provider.
--
-- One additive, NULLABLE TEXT column on identity.Tenant. It holds the EXACT
-- Cognito Hosted-UI `identity_provider` string the tenant federates through
-- (e.g. 'microsoft' for Astre). When a user lands on <slug>.aramo.ai, the login
-- redirect appends identity_provider=<this value> so Cognito skips the Google/
-- Microsoft chooser and goes straight to the tenant's IdP — the enterprise HRD
-- pattern, where federation binds to the TENANT (not the user, not a routing
-- service). Aramo already resolves subdomain→tenant via Directive A's
-- findActiveBySlug; the IdP is a property of that resolved tenant — no new table.
--
-- A STRING (not a boolean/enum): a future tenant on Okta/Google Workspace reuses
-- this column with a different value, zero schema change. NULLABLE because the
-- change is purely additive — NULL = show the chooser (today's behavior, the
-- graceful default); set = pin that provider. No data migration here — Astre is
-- backfilled to 'microsoft' via the idempotent seed (seed-astre.ts), keeping
-- this migration pure DDL. Routing reads it verbatim and FAILS OPEN to the
-- chooser on any resolution failure; the callback/reconcile spine is unchanged.
--
-- Tenant exists since 20260512000000_init_identity_model, so this only needs to
-- apply after the init migration (curated apply-lists append it after the
-- Directive-A slug ADD COLUMN — all pure additive DDL, order among them is
-- immaterial).

-- AlterTable (identity.Tenant: add the Home Realm Discovery column)
ALTER TABLE "identity"."Tenant"
    ADD COLUMN "identity_provider" TEXT;
