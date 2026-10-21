-- Talent Lifecycle R1–R5 Implementation Directive v1.2 LOCKED §7.4 (S4) — a recruiter response
-- confirmation records WHICH interaction it confirms (when the recruiter identified one). ADD-only,
-- nullable, UUID-only self-reference (no FK, the cross-record precedent); existing rows read NULL.
ALTER TABLE "communications"."CommunicationInteraction" ADD COLUMN "source_interaction_id" UUID;
