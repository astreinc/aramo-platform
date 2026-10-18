-- Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-v1_0-LOCKED §F
-- An external e-signature provider's own completion evidence (e.g. DocuSign's
-- Certificate of Completion, Adobe Acrobat Sign's audit report) is stored under its
-- own artifact role. It is never relabelled as the Aramo EXECUTION_CERTIFICATE.
-- Additive: widens the role CHECK by one value.
ALTER TABLE "documents"."DocumentArtifact" DROP CONSTRAINT "DocumentArtifact_role_check";
ALTER TABLE "documents"."DocumentArtifact" ADD CONSTRAINT "DocumentArtifact_role_check"
  CHECK ("artifact_role" IN ('TEMPLATE_SOURCE', 'SOURCE_UPLOAD', 'RENDERED_UNSIGNED', 'EXECUTED', 'EXECUTION_CERTIFICATE', 'PREVIEW', 'ATTACHMENT', 'PROVIDER_COMPLETION_EVIDENCE'));
