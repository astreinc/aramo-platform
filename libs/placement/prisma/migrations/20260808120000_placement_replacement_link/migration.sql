-- Track 3 / E4 — Replacement Authorization: additive replacement-lineage pointer.
-- Directive: Aramo-Track3-E4-ReplacementAuthorization-Directive-v1_0-LOCKED, section 4.1.
--
-- Hand-written ADDITIVE migration, NOT generated from the lifecycle registry.
-- placement:sql:check guards only the generated init migration and is unaffected.
--
-- Adds a nullable self-referential lineage pointer on PlacementProcess plus a
-- self-reference CHECK (INV-3). There is NO foreign key by deliberate
-- architecture (section 4.2): a self-FK RESTRICT breaks the single-pass
-- tenant-reset DELETE, and ON DELETE SET NULL would UPDATE a frozen terminal
-- predecessor (INV-2). Referential integrity rests entirely on the section 5
-- create-time existence, tenant, requisition and eligibility validation.
--
-- The column is intentionally NOT pinned in the generated immutability trigger
-- (section 4.3): it is nullable, and OLD = NEW over a NULL is NULL not TRUE,
-- which would reject every first-placement transition. Write-once rests on the
-- absence of an application update surface plus INV-2, the identical posture the
-- E1-c offer columns already ship under.
--
-- No backfill, no new table, tenant-reset target count unchanged at 19.

-- AlterTable
ALTER TABLE "placement"."PlacementProcess" ADD COLUMN "replaces_placement_process_id" UUID;

-- AddConstraint -- INV-3, no self-loop (a depth-1 cycle is impossible at the DB).
ALTER TABLE "placement"."PlacementProcess"
  ADD CONSTRAINT "PlacementProcess_replaces_not_self_chk"
  CHECK ("replaces_placement_process_id" IS NULL OR "replaces_placement_process_id" <> "id");
