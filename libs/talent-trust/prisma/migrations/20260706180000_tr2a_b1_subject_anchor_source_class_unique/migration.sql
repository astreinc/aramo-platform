-- TR-2a-B1 (DDR-1 §3.2) — extend the anchor idempotency key by source_class
-- Anchors are append-only and never updated. A later verification of a value
-- already anchored at a lower class must mint a NEW row at the higher class
-- rather than mutate history, so the idempotency key gains source_class. Two
-- rows for one value at two classes is the correct record and readers take the
-- strongest class per (kind, value). Prisma keeps the same 63-char truncated
-- index name for the widened key, so the old index is dropped and recreated.
DROP INDEX "talent_trust"."SubjectAnchor_tenant_id_subject_id_anchor_kind_normalized_v_key";

CREATE UNIQUE INDEX "SubjectAnchor_tenant_id_subject_id_anchor_kind_normalized_v_key" ON "talent_trust"."SubjectAnchor"("tenant_id", "subject_id", "anchor_kind", "normalized_value", "source_class");
