-- DOC-4 R-4-9 completion — add the RESERVED `esign` capability to the enum so the
-- TS CAPABILITY_VALUES catalog and the Prisma Capability type agree. RESERVED:
-- not added to any tenant's default bundle. Idempotent.
ALTER TYPE "entitlement"."Capability" ADD VALUE IF NOT EXISTS 'esign';
