# Aramo PUB-1 PR-1b (§3.2 / Amendment v1.1 G0-R2) — public-site Lightsail host.
#
# The public marketing site runs on a single Lightsail instance (nginx image
# from GHCR; see deploy/public/). This module provisions that instance, a static
# IP (so the Route 53 A records have a stable target), the attachment, and the
# 80/443 public port openings. It carries NO app config — the deploy is the
# host runbook (deploy/public/README.md) until user-data automates it.
#
# Isolated from the un-applied environments/{dev,staging,prod} ECS/Fargate
# authoring — this is its own module + its own environment root (G0-R2).

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

resource "aws_lightsail_instance" "this" {
  name              = var.instance_name
  availability_zone = var.availability_zone
  blueprint_id      = var.blueprint_id
  bundle_id         = var.bundle_id

  tags = merge(var.tags, { Name = var.instance_name })
}

# Stable public IP — the Route 53 apex/www/staging A records target this, so the
# address survives instance replacement.
resource "aws_lightsail_static_ip" "this" {
  name = "${var.instance_name}-ip"
}

resource "aws_lightsail_static_ip_attachment" "this" {
  static_ip_name = aws_lightsail_static_ip.this.name
  instance_name  = aws_lightsail_instance.this.name
}

# Only 80 + 443 are exposed (HTTP for ACME + the https redirect; HTTPS for the
# site). SSH (22) stays on Lightsail's default per-instance firewall for the
# operator; it is intentionally NOT opened to the world here.
resource "aws_lightsail_instance_public_ports" "this" {
  instance_name = aws_lightsail_instance.this.name

  port_info {
    protocol  = "tcp"
    from_port = 80
    to_port   = 80
  }

  port_info {
    protocol  = "tcp"
    from_port = 443
    to_port   = 443
  }
}
