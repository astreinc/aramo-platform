output "service_name" {
  description = "ECS service name."
  value       = aws_ecs_service.this.name
}

output "task_definition_arn" {
  description = "Task definition ARN (latest revision)."
  value       = aws_ecs_task_definition.this.arn
}

output "execution_role_arn" {
  description = "Task execution role ARN (ECR pull + logs + injected-secret reads)."
  value       = aws_iam_role.execution.arn
}

output "task_role_arn" {
  description = "Task role ARN (the app's runtime AWS principal — the compute-native successor to the iam-app-principal IAM user)."
  value       = aws_iam_role.task.arn
}
