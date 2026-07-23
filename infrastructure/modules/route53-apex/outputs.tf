output "zone_id" {
  description = "The aramo.ai hosted-zone id (passed to iam-certbot-dns to scope the ChangeResourceRecordSets statement)."
  value       = data.aws_route53_zone.this.zone_id
}

output "apex_fqdn" {
  description = "Fully-qualified name of the apex A record (aramo.ai)."
  value       = aws_route53_record.apex.fqdn
}
