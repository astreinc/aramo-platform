output "alb_security_group_id" {
  description = "ALB security group id (pass to the alb module)."
  value       = aws_security_group.alb.id
}

output "service_security_group_id" {
  description = "Shared service security group id (pass to both ecs-service module instances)."
  value       = aws_security_group.service.id
}

output "redis_security_group_id" {
  description = "Redis security group id (pass to the elasticache-redis module)."
  value       = aws_security_group.redis.id
}
