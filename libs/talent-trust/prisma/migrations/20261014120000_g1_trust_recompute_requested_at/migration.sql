-- G1 (Aramo-G1-TrustState-Recompute-Ordering-and-Recovery-Directive-v1_0-LOCKED
-- §3.3) — the durable recomputation request. ADDITIVE ONLY: one nullable column.
-- Set in the SAME transaction as every evidence creation / status change, cleared
-- only by a successful recompute that covers it, drained by the 2-minute repair job.
ALTER TABLE "talent_trust"."ResolutionSubject"
  ADD COLUMN "trust_recompute_requested_at" TIMESTAMPTZ;

-- Repair selection: oldest pending request first, tenant-scopable. Partial (WHERE)
-- is a Postgres-only index shape, not expressible in the Prisma schema, so it is
-- migration-owned (the ats_ref_partial_unique precedent).
CREATE INDEX "ResolutionSubject_trust_recompute_requested_idx"
  ON "talent_trust"."ResolutionSubject" ("trust_recompute_requested_at", "tenant_id")
  WHERE "trust_recompute_requested_at" IS NOT NULL;
