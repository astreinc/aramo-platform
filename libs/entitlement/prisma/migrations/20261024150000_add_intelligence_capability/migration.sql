-- ATI-SEP-1 T9 (ADR-0036) — add the `intelligence` capability (the Talent
-- Intelligence product) to the enum so the TS CAPABILITY_VALUES catalog and the
-- Prisma Capability type agree. Default posture OFF: no TenantEntitlement row is
-- written, so no existing tenant gains it, and it is not in the default bundle.
-- Idempotent (the add_esign_capability precedent).
ALTER TYPE "entitlement"."Capability" ADD VALUE IF NOT EXISTS 'intelligence';
