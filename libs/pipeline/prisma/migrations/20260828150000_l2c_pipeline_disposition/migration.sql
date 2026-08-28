-- Lane 2 / L2-C (D-5) -- PipelineDisposition: the immutable, authority-partitioned
-- terminal reason. ONE per pipeline_id (UNIQUE -- a second write is exact-name
-- translated to PIPELINE_ALREADY_DISPOSITIONED, never a generic P2002). Written
-- inside the terminal-transition tx (DISPOSITION and COMPLETE).

-- CreateEnum
CREATE TYPE "pipeline"."PipelineDispositionAuthority" AS ENUM ('RECRUITER', 'TALENT', 'ENGAGEMENT', 'DOWNSTREAM_OUTCOME');

-- CreateTable
CREATE TABLE "pipeline"."PipelineDisposition" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "authority_class" "pipeline"."PipelineDispositionAuthority" NOT NULL,
    "reason" TEXT NOT NULL,
    "source_provenance" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "PipelineDisposition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (the ONE-disposition-per-pipeline invariant)
CREATE UNIQUE INDEX "PipelineDisposition_pipeline_id_key" ON "pipeline"."PipelineDisposition"("pipeline_id");

-- CreateIndex
CREATE INDEX "PipelineDisposition_tenant_id_pipeline_id_idx" ON "pipeline"."PipelineDisposition"("tenant_id", "pipeline_id");

-- AddForeignKey
ALTER TABLE "pipeline"."PipelineDisposition" ADD CONSTRAINT "PipelineDisposition_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipeline"."Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;
