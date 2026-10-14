-- IC-1 PR-3 (restrict, cardinality) — one owning tenant per User, at most one
-- membership per User, membership tenant equals owner tenant, enforced by Postgres
-- (D-AUTHZ-PLATFORM-INVITE-1 Amendment A1 §1, IC-0 Gate-0 §C.1 + §K gate G6a, Supplement §1.3
-- as reconciled in the PR-3 readiness review). Apply ONLY after the PR-2 image is the running
-- image: a pre-PR-2 writer that omits tenant_id would be refused by NOT NULL.
-- Every pre-validation below is ONE statement with no inner statement-terminator and no
-- dollar quoting, so every line-based migration splitter in the test harness keeps it intact.
-- (No inline statement-terminators in these comment lines, per the comment-blind splitter guard.)

-- 1. Re-run the PR-2 backfill FIRST (rows an older image created during the PR-2
--    migrate→recreate window are born unowned and must be assigned before NOT NULL)
UPDATE "identity"."User" u
   SET "tenant_id" = m."tenant_id"
  FROM (SELECT "user_id", MIN("tenant_id"::text)::uuid AS "tenant_id", COUNT(DISTINCT "tenant_id") AS n
          FROM "identity"."UserTenantMembership" GROUP BY "user_id") m
 WHERE m."user_id" = u."id" AND m.n = 1 AND u."tenant_id" IS NULL;

-- 2. Pre-validation: no User may remain unowned (RAISES via invalid uuid cast, aborting the file)
SELECT CASE WHEN count(*) = 0 THEN NULL
            ELSE ('ic1 cardinality blocked: ' || count(*) || ' User rows without tenant_id')::uuid END AS ic1_check_unowned
  FROM "identity"."User" WHERE "tenant_id" IS NULL;

-- 3. Pre-validation: no User may hold more than one membership (the Lead forward lock)
SELECT CASE WHEN count(*) = 0 THEN NULL
            ELSE ('ic1 cardinality blocked: ' || count(*) || ' User rows with more than one membership')::uuid END AS ic1_check_multi
  FROM (SELECT "user_id" FROM "identity"."UserTenantMembership" GROUP BY "user_id" HAVING count(*) > 1) x;

-- 4. Pre-validation: every membership tenant must equal its User's owning tenant (the Lead forward lock)
SELECT CASE WHEN count(*) = 0 THEN NULL
            ELSE ('ic1 cardinality blocked: ' || count(*) || ' memberships whose tenant differs from the owner tenant')::uuid END AS ic1_check_mismatch
  FROM "identity"."UserTenantMembership" m JOIN "identity"."User" u ON u."id" = m."user_id"
 WHERE m."tenant_id" <> u."tenant_id";

-- 5. Restrict: the owner is mandatory
ALTER TABLE "identity"."User" ALTER COLUMN "tenant_id" SET NOT NULL;

-- 6. Restrict: at most one membership per User
CREATE UNIQUE INDEX "UserTenantMembership_user_id_key" ON "identity"."UserTenantMembership"("user_id");

-- 7. Restrict: membership tenant must equal the owning tenant (composite FK against UNIQUE (id, tenant_id))
--    NOT VALID then VALIDATE keeps the lock profile the same at any population
ALTER TABLE "identity"."UserTenantMembership" ADD CONSTRAINT "UserTenantMembership_user_id_tenant_id_fkey" FOREIGN KEY ("user_id", "tenant_id") REFERENCES "identity"."User"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "identity"."UserTenantMembership" VALIDATE CONSTRAINT "UserTenantMembership_user_id_tenant_id_fkey";
