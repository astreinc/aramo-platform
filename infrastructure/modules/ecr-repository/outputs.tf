output "repository_url" {
  description = "Repository URI (<account>.dkr.ecr.<region>.amazonaws.com/<name>); the ECS task definition's image reference is this URL plus a :<tag> suffix."
  value       = aws_ecr_repository.this.repository_url
}

output "repository_arn" {
  description = "ECR repository ARN (for IAM scoping if needed)."
  value       = aws_ecr_repository.this.arn
}

output "repository_name" {
  description = "ECR repository name."
  value       = aws_ecr_repository.this.name
}
