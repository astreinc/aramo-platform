-- Recruiting-Journey Evidence-Governed Milestones — L2I convergence. The provider
-- connector no longer advances evidence-backed milestones via the retired naked
-- recruiter actions; it routes provider-verified observations through the canonical
-- evidence commands. Translate existing persisted provider mapping targets from the
-- retired recruiter-action tokens to the canonical EVIDENCE-SEMANTIC tokens. The
-- business MEANING of each mapping is preserved; only the token changes. Scoped to
-- action-kind targets; a no-op where no such rows exist (safe, non-destructive).
UPDATE "integration"."PipelineProviderDispositionMapping"
   SET "mapped_target" = 'CONTACT_EVIDENCE'
 WHERE "mapped_target" = 'CONTACT' AND "target_kind" = 'action';

UPDATE "integration"."PipelineProviderDispositionMapping"
   SET "mapped_target" = 'RESPONSE_EVIDENCE'
 WHERE "mapped_target" = 'MARK_RESPONDED' AND "target_kind" = 'action';
