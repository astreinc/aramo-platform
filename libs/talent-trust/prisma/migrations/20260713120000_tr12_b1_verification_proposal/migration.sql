-- TR-12 B1 (DDR §2) — the caseworker's proposal substrate. A new talent_trust
-- table the deterministic policy engine writes proposal rows into, one per
-- (tenant, kind, subject, basis). PII-free like the advisory (kinds and ids,
-- never values). Relation-less (bare-UUID subject_id + basis_ref_id, no FK) per
-- the SubjectMergeOperation precedent for operational/worklist tables.
--
-- Closed vocabularies are TEXT (PO Ruling 2 — no native Prisma enums), enforced
-- at the DTO/service layer and documented in the schema comments.

-- CreateTable
CREATE TABLE "talent_trust"."VerificationProposal" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "trigger_kind" TEXT NOT NULL,
    "basis_ref_id" UUID NOT NULL,
    "basis_snapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMPTZ,
    "justification" TEXT,

    CONSTRAINT "VerificationProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (the dedup key — one proposal per tenant-scoped kind+subject+basis)
CREATE UNIQUE INDEX "VerificationProposal_tenant_id_kind_subject_id_basis_ref_id_key" ON "talent_trust"."VerificationProposal"("tenant_id", "kind", "subject_id", "basis_ref_id");

-- CreateIndex (the worklist surface — tenant-scoped, status-filtered)
CREATE INDEX "VerificationProposal_tenant_id_status_idx" ON "talent_trust"."VerificationProposal"("tenant_id", "status");

-- CreateIndex (the per-subject dossier pointer read)
CREATE INDEX "VerificationProposal_subject_id_idx" ON "talent_trust"."VerificationProposal"("subject_id");
