# Staging outputs — the contract consumers (app config, operators) read after
# apply. Secrets (KMS key ARN, IAM access keys) are deliberately NOT surfaced
# here: the KMS ARN is sensitive on the module, and the app principal's access
# key is generated out-of-band into the secret store (see the iam-app-principal
# module README).

output "resume_bucket_name" {
  description = "Résumé bucket name — wire to the app's S3_RESUME_BUCKET env var."
  value       = module.resume_bucket.bucket_name
}

output "api_principal_user_name" {
  description = "App-principal IAM user — generate its access key out-of-band (aws iam create-access-key) into the secret store. LEGACY: superseded by the api ECS task role (module.ecs_service_api.task_role_arn) now that compute has landed; retire in a follow-up."
  value       = module.api_principal.user_name
}

# Step-4 Directive 2 — compute / run-layer outputs.

output "alb_dns_name" {
  description = "Public DNS of the ALB — the first-deploy entry point (the edge directive fronts it with a real domain + ACM cert)."
  value       = module.alb.alb_dns_name
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
  description = "api ECS task role ARN — the compute-native app principal carrying the résumé-bucket policy (supersedes the legacy api_principal IAM user)."
  value       = module.ecs_service_api.task_role_arn
}
