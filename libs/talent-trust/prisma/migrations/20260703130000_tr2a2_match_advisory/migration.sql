-- TR-2a-2 SubjectMatchAdvisory, the within-tenant SAME-HUMAN ADVISORY. The matcher
-- surfaces a pair of ResolutionSubjects in the SAME tenant sharing a normalized anchor
-- and records this advisory for a human reviewer. ADVISE-ONLY -- writing it takes ZERO
-- merge action (no mergeSubjects, no subject status change). Tenant-scoped, keyed to a
-- CANONICAL unordered pair (subject_a_id less-than subject_b_id) so a human-pair maps to
-- exactly one advisory. PII-free -- match_basis points to SubjectAnchor rows by id, never
-- copying the normalized_value (the identifier PII stays in SubjectAnchor).

-- CreateTable
CREATE TABLE "talent_trust"."SubjectMatchAdvisory" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_a_id" UUID NOT NULL,
    "subject_b_id" UUID NOT NULL,
    "advise_band" TEXT NOT NULL,
    "has_contradiction" BOOLEAN NOT NULL DEFAULT false,
    "match_basis" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubjectMatchAdvisory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubjectMatchAdvisory_tenant_id_subject_a_id_subject_b_id_key" ON "talent_trust"."SubjectMatchAdvisory"("tenant_id", "subject_a_id", "subject_b_id");

-- CreateIndex
CREATE INDEX "SubjectMatchAdvisory_tenant_id_status_idx" ON "talent_trust"."SubjectMatchAdvisory"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "SubjectMatchAdvisory_subject_a_id_idx" ON "talent_trust"."SubjectMatchAdvisory"("subject_a_id");

-- CreateIndex
CREATE INDEX "SubjectMatchAdvisory_subject_b_id_idx" ON "talent_trust"."SubjectMatchAdvisory"("subject_b_id");

-- AddForeignKey
ALTER TABLE "talent_trust"."SubjectMatchAdvisory" ADD CONSTRAINT "SubjectMatchAdvisory_subject_a_id_fkey" FOREIGN KEY ("subject_a_id") REFERENCES "talent_trust"."ResolutionSubject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_trust"."SubjectMatchAdvisory" ADD CONSTRAINT "SubjectMatchAdvisory_subject_b_id_fkey" FOREIGN KEY ("subject_b_id") REFERENCES "talent_trust"."ResolutionSubject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
