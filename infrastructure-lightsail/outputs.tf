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
  description = "The FQDN now resolving to the box (allow for DNS propagation). The Caddy front-door (Directive 1) terminates TLS here via ACME."
  value       = aws_route53_record.app.fqdn
}

output "ssh_command" {
  description = "Convenience SSH invocation (replace the key path with the private key generated out-of-band)."
  value       = "ssh -i <path-to-private-key> ubuntu@${aws_lightsail_static_ip.this.ip_address}"
}

output "backup_iam_user_name" {
  description = "The scoped backup IAM user, if provisioned (else null). Generate its access key out-of-band; it is never in state."
  value       = var.create_backup_iam_user ? aws_iam_user.backup[0].name : null
}
