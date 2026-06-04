output "bucket_name" {
  description = "Résumé-bucket name (consumers wire this to the app's S3_RESUME_BUCKET env-var)."
  value       = aws_s3_bucket.resumes.id
}

output "bucket_arn" {
  description = "Résumé-bucket ARN."
  value       = aws_s3_bucket.resumes.arn
}

output "logs_bucket_name" {
  description = "Server-access-logs destination bucket name."
  value       = aws_s3_bucket.resumes_logs.id
}

output "kms_key_arn" {
  description = "Dedicated KMS CMK ARN for the résumé bucket. Sensitive — kept out of plan/apply logs so the key identity is not visible to anyone without state-file access."
  value       = aws_kms_key.resumes.arn
  sensitive   = true
}

output "kms_key_alias" {
  description = "Friendly alias for the dedicated KMS CMK."
  value       = aws_kms_alias.resumes.name
}

output "app_iam_policy_json" {
  description = "Least-privilege IAM policy document (JSON) the app principal needs to PUT/GET résumé objects with SSE-KMS. The role binding lives in the broader IAM module the readiness track delivers; this output is the consumer's contract."
  value       = data.aws_iam_policy_document.app_least_privilege.json
}
