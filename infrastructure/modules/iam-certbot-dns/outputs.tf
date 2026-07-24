output "user_name" {
  description = "certbot-dns IAM user name. Generate an access key for it out-of-band (aws iam create-access-key --user-name aramo-certbot-dns) and stage into the box .env as CERTBOT_AWS_ACCESS_KEY_ID / CERTBOT_AWS_SECRET_ACCESS_KEY; never commit the secret (Ruling 3)."
  value       = aws_iam_user.this.name
}

output "user_arn" {
  description = "certbot-dns IAM user ARN."
  value       = aws_iam_user.this.arn
}

output "zone_id" {
  description = "The aramo.ai hosted-zone id (read via the module's data source; for ops reference)."
  value       = data.aws_route53_zone.this.zone_id
}
