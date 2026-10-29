-- Aramo-Sign-Domain-Isolation-Reconciliation-V1-Directive-v1_0-LOCKED §4 D-3 — Aramo Sign erases
-- its own rows through its talent-erasure contract AFTER the erasure database pass, like the
-- object-storage purge. sign_erased_at records Sign's confirmation; a run reaches COMPLETED
-- only once it is set and every artifact is purged. Additive and nullable: existing rows and
-- the SECURITY DEFINER run-opening function are unaffected.
ALTER TABLE "consent"."TalentErasureRun" ADD COLUMN IF NOT EXISTS "sign_erased_at" TIMESTAMPTZ(3);
