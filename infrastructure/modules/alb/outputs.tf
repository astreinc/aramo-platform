output "alb_dns_name" {
  description = "Public DNS name of the ALB (the first-deploy entry point; the edge directive fronts it with a real domain + ACM cert)."
  value       = aws_lb.this.dns_name
}

output "alb_arn" {
  description = "ALB ARN."
  value       = aws_lb.this.arn
}

output "alb_zone_id" {
  description = "ALB canonical hosted-zone id (for the edge directive's Route 53 alias record)."
  value       = aws_lb.this.zone_id
}

output "http_listener_arn" {
  description = "HTTP :80 listener ARN."
  value       = aws_lb_listener.http.arn
}

output "api_target_group_arn" {
  description = "api target group ARN (pass to the api ecs-service module's target_group_arn)."
  value       = aws_lb_target_group.api.arn
}

output "auth_target_group_arn" {
  description = "auth-service target group ARN (pass to the auth ecs-service module's target_group_arn)."
  value       = aws_lb_target_group.auth.arn
}
