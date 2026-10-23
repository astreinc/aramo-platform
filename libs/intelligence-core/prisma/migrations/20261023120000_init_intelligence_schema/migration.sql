-- ATI-SEP-1 T0 (ADR-0036 Decision 2) — the Talent Intelligence schema in its OWN
-- database (aramo_intelligence). Applied ONLY by tools/db-sync-intelligence.sh
-- (ledger public._intelligence_migrations in the TI database). Never applied to
-- the shared Aramo DB (tools/db-sync-local.sh excludes libs/intelligence-core).
-- T1 adds the Golden subject model. splitDdl-safe: no semicolons in comments.

CREATE SCHEMA IF NOT EXISTS "intelligence";

-- CreateTable ServiceInfo
CREATE TABLE "intelligence"."ServiceInfo" (
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ServiceInfo_pkey" PRIMARY KEY ("key")
);

INSERT INTO "intelligence"."ServiceInfo" ("key", "value")
VALUES ('schema_baseline', 'ATI-SEP-1-T0')
ON CONFLICT ("key") DO NOTHING;
