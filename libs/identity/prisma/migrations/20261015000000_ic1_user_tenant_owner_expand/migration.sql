-- IC-1 PR-2 (expand) — owning tenant on identity.User, NULLABLE during migration
-- (D-AUTHZ-PLATFORM-INVITE-1 Amendment A1, one User / one tenant, IC-0 Gate-0 §C.1 + Supplement §1.1)
-- Safe to apply BEFORE the image is recreated (deploy/migrate-prod.sh ordering): nothing
-- reads this column yet, the old image never names it, NULLs are not FK-checked
-- (MATCH SIMPLE) and NULLs are distinct under the composite UNIQUE. The PR-3 restrict
-- migration (NOT NULL, membership uniqueness, composite FK, trigger) is a separate gate.
-- (No inline statement-terminators in these comment lines, per the comment-blind splitter guard.)

-- AlterTable
ALTER TABLE "identity"."User" ADD COLUMN "tenant_id" UUID;

-- CreateIndex
CREATE INDEX "User_tenant_id_idx" ON "identity"."User"("tenant_id");

-- AddForeignKey (owner tenant must exist, NULL unchecked)
ALTER TABLE "identity"."User" ADD CONSTRAINT "User_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "identity"."Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The composite target for the PR-3 membership-to-owner FK (precedent Company_tenant_id_id_key)
ALTER TABLE "identity"."User" ADD CONSTRAINT "User_id_tenant_id_key" UNIQUE ("id", "tenant_id");
