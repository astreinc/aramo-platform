-- Portal P4 P4a (Aramo-Portal-P4-Directive-v1_0-LOCKED PR-1.2, D-4) -- the durable
-- notice-delivery record. Talent-rail (references portal_user_id), so it lives in
-- portal_identity, never in platform_trust (which keeps its no-PII wall). The
-- DormantLink notice_version/notice_delivered_at columns are populated FROM a row
-- here (app-layer provenance). portal_user-keyed, UUID-only ref, NO FK per the
-- portal_identity cross-ref convention. Append-only. Erased with the PortalUser by
-- the talent RTBF surface (P4b).
CREATE TABLE "portal_identity"."NoticeDelivery" (
    "id" UUID NOT NULL,
    "portal_user_id" UUID NOT NULL,
    "notice_version" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "delivered_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoticeDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NoticeDelivery_portal_user_id_idx" ON "portal_identity"."NoticeDelivery"("portal_user_id");
