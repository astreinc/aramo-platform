# Nothing secret: names and ARNs only. Access keys are created out of band.

output "backup_s3_uri" {
  description = "BACKUP_S3_URI for /etc/aramo/backup.conf on the box."
  value       = "s3://${aws_s3_bucket.backups.bucket}"
}

output "backup_kms_key_arn" {
  description = "BACKUP_KMS_KEY_ID for /etc/aramo/backup.conf and the restorer profile (sent as --ssekms-key-id on every upload)."
  value       = aws_kms_key.backups.arn
}

output "backup_kms_alias" {
  description = "Alias of the SSE-KMS key."
  value       = aws_kms_alias.backups.name
}

output "writer_user_name" {
  description = "IAM user for the box (create its access key out of band → /etc/aramo/backup.conf)."
  value       = aws_iam_user.writer.name
}

output "restorer_user_name" {
  description = "IAM user for the operator Mac restore profile (create its access key out of band)."
  value       = aws_iam_user.restorer.name
}

output "alert_topic_arn" {
  description = "SNS topic of the backup-freshness alerts."
  value       = aws_sns_topic.backup_alerts.arn
}

output "freshness_function_name" {
  description = "The freshness-check Lambda (invoke it once after the first run to test the alert path)."
  value       = aws_lambda_function.freshness.function_name
}
