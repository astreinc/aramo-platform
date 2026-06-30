-- Step 4b (Architecture Realignment, ADR-0016) — additive ingestion column
-- owned BY ingestion (per Directive §1 Ruling 3: each schema owned by exactly
-- one Prisma module; canonicalization mirrors it as a follower, drift-tripwire
-- enforced).
--
-- resolved_cluster_id (UUID, nullable) — the cross-tenant resolution anchor:
-- the identity_index.PersonCluster id this payload resolved to (PII-free,
-- fingerprint-matched). DISTINCT from resolved_talent_id (the per-tenant Core
-- husk). One human across tenants shares ONE cluster but gets a husk per
-- tenant. Set only when a verified_email produced a fingerprint; NULL
-- otherwise. Cross-schema reference is UUID-only without FK (Architecture §7.3).
--
-- Additive-only. No existing column mutated; resolved_talent_id is preserved
-- (it remains the idempotency anchor + the per-tenant husk pointer).

-- AlterTable
ALTER TABLE "ingestion"."RawPayloadReference"
    ADD COLUMN "resolved_cluster_id" UUID;
