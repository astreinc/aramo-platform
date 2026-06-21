output "vpc_id" {
  description = "ID of the created VPC."
  value       = aws_vpc.this.id
}

output "db_subnet_ids" {
  description = "List of DB subnet IDs (≥2 across distinct AZs); pass to RDS module's subnet_ids input."
  value       = aws_subnet.db[*].id
}

output "rds_security_group_id" {
  description = "ID of the RDS security group; pass to RDS module's vpc_security_group_ids input (as single-element list)."
  value       = aws_security_group.rds.id
}

# Step-4 Directive 2 — compute-tier networking outputs.

output "vpc_cidr" {
  description = "The VPC IPv4 CIDR block (consumers that need in-VPC CIDR scoping)."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet IDs (≥2 across distinct AZs); pass to the ALB module's subnets input."
  value       = aws_subnet.public[*].id
}

output "private_app_subnet_ids" {
  description = "Private-app subnet IDs (≥2 across distinct AZs); pass to the ECS service + ElastiCache modules (Fargate tasks + Redis run here)."
  value       = aws_subnet.private_app[*].id
}
