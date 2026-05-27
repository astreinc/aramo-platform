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
