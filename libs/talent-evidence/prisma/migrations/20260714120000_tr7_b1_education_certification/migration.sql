-- TR-7 B1 (D2) — the credential-claim capture: two typed talent_evidence models
-- for declared academic degrees and professional certifications, per the
-- TalentWorkHistoryEntry precedent. institution_name/degree_name and
-- certification_name are NOT NULL so the pure canonical mappers always carry their
-- required fields (the write-gate conformance property). Dates are DATE (calendar
-- granularity). Source enums cover résumé/manual/import arrivals only.

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentEducationSource" AS ENUM ('resume', 'manual', 'import');

-- CreateEnum
CREATE TYPE "talent_evidence"."TalentCertificationSource" AS ENUM ('resume', 'manual', 'import');

-- CreateTable
CREATE TABLE "talent_evidence"."TalentEducationEntry" (
    "id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "institution_name" TEXT NOT NULL,
    "degree_name" TEXT NOT NULL,
    "field_of_study" TEXT,
    "conferred_date" DATE,
    "evidence_text" TEXT,
    "source" "talent_evidence"."TalentEducationSource" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "TalentEducationEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_evidence"."TalentCertificationEntry" (
    "id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "certification_name" TEXT NOT NULL,
    "issuer_name" TEXT,
    "credential_ref" TEXT,
    "issued_date" DATE,
    "expiry_date" DATE,
    "evidence_text" TEXT,
    "source" "talent_evidence"."TalentCertificationSource" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "TalentCertificationEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TalentEducationEntry_tenant_id_idx" ON "talent_evidence"."TalentEducationEntry"("tenant_id");

-- CreateIndex
CREATE INDEX "TalentEducationEntry_tenant_id_talent_id_idx" ON "talent_evidence"."TalentEducationEntry"("tenant_id", "talent_id");

-- CreateIndex
CREATE INDEX "TalentCertificationEntry_tenant_id_idx" ON "talent_evidence"."TalentCertificationEntry"("tenant_id");

-- CreateIndex
CREATE INDEX "TalentCertificationEntry_tenant_id_talent_id_idx" ON "talent_evidence"."TalentCertificationEntry"("tenant_id", "talent_id");
