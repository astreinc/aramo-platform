-- TR-2a-1 SubjectAnchor, the within-tenant match index. A thin derived
-- projection over the anchor EvidenceRecord (source_evidence_id points back at
-- the source of truth). Tenant-scoped and keyed to the origin subject (the
-- un-merge contract). The normalized identifier is PII and lives ONLY in this
-- tenant-scoped schema, NEVER in identity_index (the I14 wall).

-- CreateTable
CREATE TABLE "talent_trust"."SubjectAnchor" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "anchor_kind" TEXT NOT NULL,
    "normalized_value" TEXT NOT NULL,
    "source_evidence_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubjectAnchor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubjectAnchor_tenant_id_subject_id_anchor_kind_normalized_v_key" ON "talent_trust"."SubjectAnchor"("tenant_id", "subject_id", "anchor_kind", "normalized_value");

-- CreateIndex
CREATE INDEX "SubjectAnchor_tenant_id_anchor_kind_normalized_value_idx" ON "talent_trust"."SubjectAnchor"("tenant_id", "anchor_kind", "normalized_value");

-- CreateIndex
CREATE INDEX "SubjectAnchor_subject_id_idx" ON "talent_trust"."SubjectAnchor"("subject_id");

-- AddForeignKey
ALTER TABLE "talent_trust"."SubjectAnchor" ADD CONSTRAINT "SubjectAnchor_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "talent_trust"."ResolutionSubject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
