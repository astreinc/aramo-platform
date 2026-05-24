output "arn" {
  description = "ARN of the created CloudWatch log group."
  value       = aws_cloudwatch_log_group.this.arn
}

output "name" {
  description = "Name of the created CloudWatch log group."
  value       = aws_cloudwatch_log_group.this.name
}
