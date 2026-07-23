# Prod outputs — the contract consumers (app config, operators) read after
# apply. Secrets (KMS ARNs, Secrets Manager values) are deliberately NOT
# surfaced. Introduced with Step-4 Directive 2 (prod previously had no
# outputs.tf).

output "resume_bucket_name" {
  description = "Résumé bucket name — wire to the app's S3_RESUME_BUCKET env var (already injected into the api task via compute.tf)."
  value       = module.resume_bucket.bucket_name
}

# Step-4 Directive 2 — compute / run-layer outputs.

output "alb_dns_name" {
  description = "Public DNS of the ALB — the first-deploy entry point (the edge directive fronts it with a real domain + ACM cert)."
  value       = module.alb.alb_dns_name
}

output "alb_zone_id" {
  description = "ALB canonical hosted-zone id (for the edge directive's Route 53 alias record)."
  value       = module.alb.alb_zone_id
}

output "ecr_api_repository_url" {
  description = "ECR repo URI for the api image (docker push target)."
  value       = module.ecr_api.repository_url
}

output "ecr_auth_repository_url" {
  description = "ECR repo URI for the auth-service image (docker push target)."
  value       = module.ecr_auth.repository_url
}

output "api_task_role_arn" {
  description = "api ECS task role ARN — the prod app principal (carries the résumé-bucket policy; closes the recon's staging/prod IAM gap with the compute-native principal)."
  value       = module.ecs_service_api.task_role_arn
}

output "auth_task_role_arn" {
  description = "auth-service ECS task role ARN."
  value       = module.ecs_service_auth.task_role_arn
}

# Front-Door Migration PR-0 (ADR-0023).

output "frontdoor_zone_id" {
  description = "The aramo.ai hosted-zone id (read via data source; feeds PR-2/PR-3 DNS wiring)."
  value       = module.route53_apex.zone_id
}

output "certbot_user_name" {
  description = "certbot DNS-01 IAM user name — generate its access key out-of-band per doc/runbooks/frontdoor-pr0-apply.md (Ruling 3); never surface the secret."
  value       = module.certbot_dns.user_name
}
