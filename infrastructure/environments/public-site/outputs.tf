output "static_ip" {
  description = "Public static IP of the Lightsail host — the DNS target and the SSH/deploy address (deploy/public/README.md)."
  value       = module.public_site.static_ip
}

output "zone_id" {
  description = "The aramo.ai hosted-zone id (data source) the A records were written into."
  value       = data.aws_route53_zone.aramo.zone_id
}

output "instance_name" {
  description = "Lightsail instance name."
  value       = module.public_site.instance_name
}

output "intake_mailer_user_name" {
  description = "IAM user for the intake handler's SES send. The PO creates its access key MANUALLY (never in TF state) and places it in the host .env."
  value       = aws_iam_user.intake_mailer.name
}

output "intake_mailer_user_arn" {
  description = "ARN of the intake-mailer IAM user."
  value       = aws_iam_user.intake_mailer.arn
}
