-- TR-4 B1 (DDR §2.4) — EvidenceLink semantic uniqueness (one fact, one row)
--
-- The link vocabulary landed without a uniqueness guard, so contradict/supersede
-- were at-least-once (a repeat raise duplicated the row). B1 makes a
-- (from_evidence_id, to_evidence_id, relation) triple unique the service now
-- existence-checks first, so a repeat is a no-op, and the DB rejects any stray dup
--
-- tenant_id is intentionally OUT of the key the evidence ids are globally unique
-- UUIDs, so the triple is already tenant-unambiguous adding tenant_id would let a
-- cross-tenant duplicate slip through
--
-- DEDUPE FIRST collapse any pre-existing exact-duplicate rows to one row per triple
-- (keep the smallest physical ctid) before the index is built the append-only
-- trigger guards BEFORE UPDATE only, so this one-time DELETE of semantically
-- identical audit rows is permitted and required for the constraint uuid has no
-- MIN aggregate, so the dedup keys on ctid not id

DELETE FROM "talent_trust"."EvidenceLink" a
USING "talent_trust"."EvidenceLink" b
WHERE a."from_evidence_id" = b."from_evidence_id"
  AND a."to_evidence_id" = b."to_evidence_id"
  AND a."relation" = b."relation"
  AND a."ctid" > b."ctid";

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceLink_from_evidence_id_to_evidence_id_relation_key" ON "talent_trust"."EvidenceLink"("from_evidence_id", "to_evidence_id", "relation");
