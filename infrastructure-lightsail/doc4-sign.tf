# DOC-4 (R-4-5, R-4-7, R-4-10) — E-Sign operational infrastructure. AUTHORED,
# NOT APPLIED (DEPLOY=NO). Terraform is applied ONLY from the Mac (the box hits
# the wrong AWS account / 403 on the state bucket). Until applied, the
# sign-service runs with the software evidence signer + the local no-op event
# publisher (both env-gated defaults), so no live AWS dependency exists.
#
# When applied (from the Mac, into account 472534873684):
#   - the KMS asymmetric key backs EvidenceManifestSignerPort (SIGN_KMS_KEY_ID);
#     the private key never leaves KMS (§262).
#   - the SNS topic backs EventPublisherPort (SIGN_EVENT_BUS_TOPIC_ARN); the
#     apps/api write-back consumer subscribes. Messages carry refs only — no
#     document bytes / PII (§12/§341).

# ── KMS asymmetric signing key for execution-evidence manifests (R-4-5) ─────────
resource "aws_kms_key" "sign_evidence" {
  description = "Aramo DOC-4 execution-evidence manifest signing (asymmetric, sign/verify)"
  key_usage   = "SIGN_VERIFY"
  # The AWS provider (~> 5.0) names this attribute itself; its spelling is the one
  # field-scoped vocabulary exemption (scripts/verify-vocabulary.sh, §3.8).
  customer_master_key_spec = "RSA_2048"
  enable_key_rotation      = false # rotation is N/A for asymmetric SIGN_VERIFY keys
  deletion_window_in_days  = 30
  # SX-2 / LC-3 (Executed-Artifact Custody directive): reused as the evidence key;
  # explicit key policy in sign-artifacts.tf (break-glass admin, aramo-sign-prod use).
  policy = data.aws_iam_policy_document.sign_evidence_kms.json
}

resource "aws_kms_alias" "sign_evidence" {
  name          = "alias/aramo-sign-evidence"
  target_key_id = aws_kms_key.sign_evidence.key_id
}

# ── SNS topic for the operational executed-envelope event bus (R-4-7) ───────────
resource "aws_sns_topic" "sign_executed" {
  name = "aramo-sign-executed"
}

output "sign_kms_key_id" {
  description = "SIGN_KMS_KEY_ID for the sign-service KMS evidence signer."
  value       = aws_kms_alias.sign_evidence.name
}

output "sign_event_bus_topic_arn" {
  description = "SIGN_EVENT_BUS_TOPIC_ARN for the sign-service SNS event publisher."
  value       = aws_sns_topic.sign_executed.arn
}
