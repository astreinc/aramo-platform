-- Recruiting-Journey Evidence-Governed Milestones (§7/§16, I3) — generalize the
-- CommunicationInteraction to carry recruiter-attested off-platform evidence as a
-- first-class provenance mode ALONGSIDE provider-backed interactions. No second
-- evidence store, no fabricated provider connection: the fact ("Talent responded by
-- phone/email/SMS/other") is still a communication interaction.

-- 1) Canonical evidence authority. STORED, never derived from status. The value
--    provider_verified means mediated by an integration connection, whereas
--    recruiter_attested means a recruiter attested account of an off-platform
--    contact or response.
CREATE TYPE "communications"."CommunicationEvidenceAuthority" AS ENUM (
  'provider_verified',
  'recruiter_attested'
);

-- 2) Neutral terminal status for an attested interaction. It has NO provider
--    semantics (never connected/completed), so an attested callback can never be
--    read as a provider-verified two-way call.
ALTER TYPE "communications"."CommunicationInteractionStatus" ADD VALUE IF NOT EXISTS 'recorded';

-- 2b) `other` channel — a recruiter-attested response via an unintegrated channel
--     (the FE "Other" tile). Only attested records use it; no provider emits it.
ALTER TYPE "communications"."CommunicationChannel" ADD VALUE IF NOT EXISTS 'other';

-- 3) Add the authority column. DEFAULT provider_verified classifies every existing
--    (provider-mediated) row correctly as part of this migration — a backfill that
--    fabricates NO new provenance (every pre-existing row carried a real integration
--    connection). Downstream engagement/submittal grading is therefore unchanged.
ALTER TABLE "communications"."CommunicationInteraction"
  ADD COLUMN "evidence_authority" "communications"."CommunicationEvidenceAuthority" NOT NULL DEFAULT 'provider_verified';

-- 4) integration_connection_id becomes NULLABLE — NULL ONLY for recruiter-attested
--    provenance (no provider connection, no sentinel). Provider-backed (Microsoft /
--    Zoom) rows keep their real, required connection id via the application layer.
ALTER TABLE "communications"."CommunicationInteraction"
  ALTER COLUMN "integration_connection_id" DROP NOT NULL;
