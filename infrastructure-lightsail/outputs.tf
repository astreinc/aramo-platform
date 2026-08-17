# Outputs the PO reads after apply to drive the remaining manual/runbook steps
# (the §5 Cognito setup, the .env, the deploy). No secrets are surfaced — the
# backup IAM access key is generated out-of-band and never enters state.

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

output "backup_iam_user_name" {
  description = "The scoped backup IAM user, if provisioned (else null). Generate its access key out-of-band; it is never in state."
  value       = var.create_backup_iam_user ? aws_iam_user.backup[0].name : null
}

output "certbot_user_name" {
  description = "Front-door wildcard-TLS DNS-01 IAM user name (ADR-0023 / PR-0c) — generate its access key out-of-band per doc/runbooks/frontdoor-pr0-apply.md; the secret never enters state."
  value       = module.certbot_dns.user_name
}
