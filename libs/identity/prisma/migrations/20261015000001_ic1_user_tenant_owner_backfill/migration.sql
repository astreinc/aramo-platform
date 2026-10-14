-- IC-1 PR-2 (backfill) — assign each identity.User its single membership tenant
-- (IC-0 Gate-0 §K gate G4, Supplement §1.2 as reconciled in the PR-2 readiness report §3.2)
-- Preconditions proven by the IC-0 production preflight (D2 = 0 Users without a
-- membership, D3 = 0 Users in more than one distinct tenant) and re-asserted below.
-- Data only, idempotent and re-runnable (the PR-3 restrict migration re-runs it before
-- SET NOT NULL to cover rows an older image created during the migrate→recreate window).
-- Only Users with EXACTLY one membership tenant receive it (the n = 1 guard), so no
-- identity is ever merged, split or re-pointed here.
-- The post-condition is ONE statement with no inner statement-terminator and no dollar
-- quoting, so every line-based migration splitter in the test harness keeps it intact.
-- (No inline statement-terminators in these comment lines, per the comment-blind splitter guard.)

-- Backfill
UPDATE "identity"."User" u
   SET "tenant_id" = m."tenant_id"
  FROM (SELECT "user_id", MIN("tenant_id"::text)::uuid AS "tenant_id", COUNT(DISTINCT "tenant_id") AS n
          FROM "identity"."UserTenantMembership" GROUP BY "user_id") m
 WHERE m."user_id" = u."id" AND m.n = 1 AND u."tenant_id" IS NULL;

-- Post-condition: RAISES (invalid uuid cast) when any User still lacks an owner, which
-- aborts this single-transaction file so deploy/migrate-prod.sh stops before recreate
SELECT CASE WHEN count(*) = 0 THEN NULL
            ELSE ('ic1 backfill incomplete: ' || count(*) || ' User rows without tenant_id')::uuid END AS ic1_backfill_check
  FROM "identity"."User" WHERE "tenant_id" IS NULL;
