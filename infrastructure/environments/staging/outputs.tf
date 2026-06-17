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
  description = "App-principal IAM user — generate its access key out-of-band (aws iam create-access-key) into the secret store."
  value       = module.api_principal.user_name
}
