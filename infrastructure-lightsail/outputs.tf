# Outputs the PO reads after apply to drive the remaining manual/runbook steps
# (the §5 Cognito setup, the .env, the deploy). No secrets are surfaced; no access key ever enters state.

output "instance_name" {
  description = "The Lightsail instance name."
  value       = aws_lightsail_instance.this.name
}

output "static_ip" {
  description = "The stable public IPv4 attached to the box — the value the A record points at, and the SSH target."
  value       = aws_lightsail_static_ip.this.ip_address
}

output "app_fqdn" {
  description = "The FQDN now resolving to the box when this root manages DNS (allow for DNS propagation); null when manage_dns=false (a parallel box that does not own the production records)."
  value       = var.manage_dns ? aws_route53_record.app[0].fqdn : null
}

output "ssh_command" {
  description = "Convenience SSH invocation (replace the key path with the private key generated out-of-band)."
  value       = "ssh -i <path-to-private-key> ubuntu@${aws_lightsail_static_ip.this.ip_address}"
}

output "certbot_user_name" {
  description = "Front-door wildcard-TLS DNS-01 IAM user name (ADR-0023 / PR-0c) — generate its access key out-of-band per doc/runbooks/frontdoor-pr0-apply.md; the secret never enters state."
  value       = module.certbot_dns.user_name
}

# --- Aramo Sign artifact custody (SX-2) -------------------------------------

output "sign_artifacts_bucket" {
  description = "The dedicated Sign artifact bucket name, for the sign-service env at the credential switch."
  value       = aws_s3_bucket.sign_artifacts.id
}

output "sign_artifacts_kms_key_arn" {
  description = "ARN of the Sign artifact bucket's SSE-KMS key."
  value       = aws_kms_key.sign_artifacts.arn
}

output "sign_evidence_signing_algorithm" {
  description = "SIGN_KMS_SIGNING_ALGORITHM for sign-service with the RSA_2048 evidence key (SIGN_KMS_KEY_ID = output sign_kms_key_id, doc4-sign.tf)."
  value       = "RSASSA_PSS_SHA_256"
}

output "sign_iam_user_name" {
  description = "The sign-service IAM user. Create its access key out-of-band at the credential-switch checkpoint; the secret never enters state."
  value       = aws_iam_user.sign.name
}

output "sign_audit_trail_arn" {
  description = "ARN of the Sign audit CloudTrail trail."
  value       = aws_cloudtrail.sign_audit.arn
}
