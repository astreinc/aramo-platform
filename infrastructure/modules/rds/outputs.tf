output "endpoint" {
  description = "Connection endpoint of the RDS instance (host:port format). Marked sensitive to keep host:port out of plan/apply logs."
  value       = aws_db_instance.this.endpoint
  sensitive   = true
}

output "port" {
  description = "Database port (typically 5432 for Postgres)."
  value       = aws_db_instance.this.port
}

output "arn" {
  description = "ARN of the RDS instance."
  value       = aws_db_instance.this.arn
}

output "master_user_secret_arn" {
  description = "ARN of the AWS Secrets Manager secret holding the master user password (auto-managed via manage_master_user_password = true)."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
  sensitive   = true
}
