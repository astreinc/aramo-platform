output "static_ip" {
  description = "The attached static public IP — the target for the Route 53 apex/www/staging A records."
  value       = aws_lightsail_static_ip.this.ip_address
}

output "static_ip_name" {
  description = "Lightsail static-IP resource name."
  value       = aws_lightsail_static_ip.this.name
}

output "instance_name" {
  description = "Lightsail instance name."
  value       = aws_lightsail_instance.this.name
}
