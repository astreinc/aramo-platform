# DOC-4 (R-4-5, R-4-7, R-4-10) — E-Sign operational infrastructure. AUTHORED,
# NOT APPLIED (DEPLOY=NO). Terraform is applied ONLY from the Mac (the box hits
# the wrong AWS account / 403 on the state bucket). Until applied, the
# esign-service runs with the software evidence signer + the local no-op event
# publisher (both env-gated defaults), so no live AWS dependency exists.
#
# When applied (from the Mac, into account 472534873684):
#   - the KMS asymmetric key backs EvidenceManifestSignerPort (ESIGN_KMS_KEY_ID);
#     the private key never leaves KMS (§262).
#   - the SNS topic backs EventPublisherPort (ESIGN_EVENT_BUS_TOPIC_ARN); the
#     apps/api write-back consumer subscribes. Messages carry refs only — no
#     document bytes / PII (§12/§341).

# ── KMS asymmetric signing key for execution-evidence manifests (R-4-5) ─────────
resource "aws_kms_key" "esign_evidence" {
  description             = "Aramo DOC-4 execution-evidence manifest signing (asymmetric, sign/verify)"
  key_usage               = "SIGN_VERIFY"
  key_spec                = "RSA_2048" # newer aws-provider alias (avoids the retired long attribute name)
  enable_key_rotation     = false      # rotation is N/A for asymmetric SIGN_VERIFY keys
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "esign_evidence" {
  name          = "alias/aramo-esign-evidence"
  target_key_id = aws_kms_key.esign_evidence.key_id
}

# ── SNS topic for the operational executed-envelope event bus (R-4-7) ───────────
resource "aws_sns_topic" "esign_executed" {
  name = "aramo-esign-executed"
}

output "esign_kms_key_id" {
  description = "ESIGN_KMS_KEY_ID for the esign-service KMS evidence signer."
  value       = aws_kms_alias.esign_evidence.name
}

output "esign_event_bus_topic_arn" {
  description = "ESIGN_EVENT_BUS_TOPIC_ARN for the esign-service SNS event publisher."
  value       = aws_sns_topic.esign_executed.arn
}
