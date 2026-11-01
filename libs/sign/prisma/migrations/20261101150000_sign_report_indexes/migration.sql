-- Aramo-Sign-Feature-Parity-Program-Directive v1.0 (LOCKED, 2bd74ca5) §1.13 — basic reports.
--
-- ADDITIVE, index-only: no column, constraint, trigger or returned shape changes. The report
-- queries select one tenant's envelopes by sent_at (the cohort and the volume series) and by
-- created_at (the envelope audit export); these two composite indexes keep both range scans
-- on the tenant's own rows instead of every envelope of the tenant.
CREATE INDEX "SignatureEnvelope_tenant_sent_at_idx" ON "sign"."SignatureEnvelope" ("tenant_id", "sent_at");
CREATE INDEX "SignatureEnvelope_tenant_created_at_idx" ON "sign"."SignatureEnvelope" ("tenant_id", "created_at");
