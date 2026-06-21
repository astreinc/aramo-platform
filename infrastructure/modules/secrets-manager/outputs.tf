output "secret_arns" {
  description = "Map of logical secret name → ARN. Consumers wire these into the ECS task definition (execution-role `secrets` injection or task-role GetSecretValue)."
  value       = { for k, s in aws_secretsmanager_secret.this : k => s.arn }
}

output "secret_full_names" {
  description = "Map of logical secret name → full Secrets Manager name (aramo/<env>/<name>)."
  value       = { for k, s in aws_secretsmanager_secret.this : k => s.name }
}

output "all_secret_arns" {
  description = "Flat list of every secret ARN in this module (convenience for IAM scoping)."
  value       = [for s in aws_secretsmanager_secret.this : s.arn]
}
