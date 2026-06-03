-- T2-2a — additive ingestion columns owned BY ingestion (not by
-- canonicalization), per Directive §1 Ruling 3: each schema is owned by
-- exactly one Prisma module. ingestion owns the ingestion PG schema;
-- canonicalization mirrors it as a follower (the drift-tripwire CI test
-- enforces bit-identical follower view).
--
-- Two additive nullable additions:
--   - resolution_method (ResolutionMethod enum, NEW) — the method-of-
--     resolution record (T2-1 Decision 4 / T2-2a ASSOCIATE-NOT-RESOLVE).
--   - resolved_talent_id (UUID, nullable) — the idempotency anchor +
--     pointer to the Core Talent the canonicalize service associated
--     this payload with. Non-null → re-canonicalization is a no-op.
--
-- Additive-only. CREATE TYPE + ALTER TABLE ADD COLUMN. No existing column
-- mutated. Cross-schema reference is UUID-only without FK (Architecture
-- v2.0 §7.3).

-- CreateEnum
CREATE TYPE "ingestion"."ResolutionMethod" AS ENUM ('new_identity', 'verified_email_match', 'caller_supplied');

-- AlterTable
ALTER TABLE "ingestion"."RawPayloadReference"
    ADD COLUMN "resolved_talent_id" UUID,
    ADD COLUMN "resolution_method" "ingestion"."ResolutionMethod";
