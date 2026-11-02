-- CONTACTS-1 (LOCKED v1.0) §5 + §12 — contact soft delete + contact kind.
--
-- Additive only: three nullable columns, one CHECK, one index. No backfill,
-- no drops. Existing rows stay live (deleted_at NULL) and unclassified
-- (contact_kind NULL).

ALTER TABLE "contact"."Contact"
    ADD COLUMN "contact_kind" TEXT,
    ADD COLUMN "deleted_at" TIMESTAMPTZ,
    ADD COLUMN "deleted_by_id" UUID;

ALTER TABLE "contact"."Contact"
    ADD CONSTRAINT "Contact_contact_kind_check"
    CHECK ("contact_kind" IS NULL OR "contact_kind" IN ('PERSON', 'FUNCTIONAL_MAILBOX'));

CREATE INDEX "Contact_tenant_id_deleted_at_idx"
    ON "contact"."Contact"("tenant_id", "deleted_at");
