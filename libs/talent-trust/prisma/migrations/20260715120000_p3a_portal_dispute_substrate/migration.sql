-- Portal P3a (Aramo-Portal-P3-Directive-v1_0 §PR-1, rulings 2-5) — the portal-
-- actor dispute substrate in talent_trust. ONE portal-visible dispute
-- (PortalDispute, cluster-scoped) fans out to N tenant-scoped work items
-- (PortalDisputeWorkItem, subject keyspace) plus an append-only statement stream
-- (PortalDisputeStatement, the D7 hash-envelope inline).
--
-- SUBSTRATE ONLY — no TR-15 lifecycle event fires at open (that wiring is P3b).
--
-- WorkItem and Statement CASCADE from the parent so RTBF erasure lists only the
-- parent (the pipeline-cascade convention). Closed vocabularies are TEXT (PO
-- Ruling 2), enforced at the DTO/service layer. Cross-schema refs are bare UUIDs
-- with no FK (I1). Comments here are semicolon-free (the integration DDL splitter
-- splits on the statement terminator outside dollar-quotes).

-- CreateTable
CREATE TABLE "talent_trust"."PortalDispute" (
    "id" UUID NOT NULL,
    "cluster_id" UUID NOT NULL,
    "item_type" TEXT NOT NULL,
    "item_id_digest" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution_note" TEXT,
    "opened_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triage_due_at" TIMESTAMPTZ NOT NULL,
    "summary_due_at" TIMESTAMPTZ NOT NULL,
    "reinvestigation_due_at" TIMESTAMPTZ NOT NULL,
    "reinvestigation_extended_at" TIMESTAMPTZ,
    "ccpa_due_at" TIMESTAMPTZ,
    "ccpa_extended_due_at" TIMESTAMPTZ,
    "withdrawn_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_trust"."PortalDisputeWorkItem" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "item_type" TEXT NOT NULL,
    "underlying_ref_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalDisputeWorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_trust"."PortalDisputeStatement" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "author" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "statement_hash" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'portal',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalDisputeStatement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (the talent's dispute list, status-filtered)
CREATE INDEX "PortalDispute_cluster_id_status_idx" ON "talent_trust"."PortalDispute"("cluster_id", "status");

-- CreateIndex (the open-idempotency read — one non-terminal dispute per item)
CREATE INDEX "PortalDispute_cluster_id_item_type_item_id_digest_idx" ON "talent_trust"."PortalDispute"("cluster_id", "item_type", "item_id_digest");

-- CreateIndex (the tenant worklist surface, P3b)
CREATE INDEX "PortalDisputeWorkItem_tenant_id_status_idx" ON "talent_trust"."PortalDisputeWorkItem"("tenant_id", "status");

-- CreateIndex (the per-subject read — dossier / erasure inventory keyspace)
CREATE INDEX "PortalDisputeWorkItem_subject_id_idx" ON "talent_trust"."PortalDisputeWorkItem"("subject_id");

-- CreateIndex
CREATE INDEX "PortalDisputeWorkItem_dispute_id_idx" ON "talent_trust"."PortalDisputeWorkItem"("dispute_id");

-- CreateIndex (the append-only statement stream, oldest-first)
CREATE INDEX "PortalDisputeStatement_dispute_id_created_at_idx" ON "talent_trust"."PortalDisputeStatement"("dispute_id", "created_at");

-- AddForeignKey
ALTER TABLE "talent_trust"."PortalDisputeWorkItem" ADD CONSTRAINT "PortalDisputeWorkItem_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "talent_trust"."PortalDispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_trust"."PortalDisputeStatement" ADD CONSTRAINT "PortalDisputeStatement_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "talent_trust"."PortalDispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
