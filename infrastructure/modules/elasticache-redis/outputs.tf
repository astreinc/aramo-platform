output "primary_endpoint_address" {
  description = "Primary endpoint host for the Redis replication group. Compose REDIS_URL as redis://<this>:<port>."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "port" {
  description = "Redis port (6379)."
  value       = aws_elasticache_replication_group.this.port
}

output "redis_url" {
  description = "Convenience-assembled REDIS_URL (redis://host:port) for the app env. Transit encryption is off (redis://, not rediss://) per the module's first-deploy posture."
  value       = "redis://${aws_elasticache_replication_group.this.primary_endpoint_address}:${aws_elasticache_replication_group.this.port}"
}
