# Aramo Step-4 Directive 2 (compute IaC) — Application Load Balancer.
#
# One internet-facing ALB (public subnets) fronting the two backend
# services, with an `ip`-target group per service (Fargate awsvpc tasks
# register by IP) and path-based routing:
#
#   /auth/*, /.well-known/*  ──▶ auth-service target group
#   everything else (default) ──▶ api target group
#
# HTTPS SEAM: only an HTTP :80 listener is created here — acceptable for
# first-apply validation. The ACM cert + the HTTPS :443 listener + public
# DNS are the EDGE directive (DNS-dependent); the ALB SG already permits
# 443 so adding the HTTPS listener later is non-structural.
#
# HEALTH CHECKS: the apps ship no /health route (D1's container probe is a
# raw TCP connect). An ALB target group is L7, so the closest equivalent is
# an HTTP check whose matcher accepts whatever the app returns:
#   - api : path "/" with matcher "200-499" — any HTTP response proves the
#           listener is serving (the L7 analogue of D1's TCP probe).
#   - auth: path "/.well-known/jwks.json" with matcher "200" — a real
#           readiness signal that already exists (D1 smoke-tested it).
# Both are overridable per env. The D1 TCP container healthCheck is wired
# separately in the ecs-service task definition.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# This ALB is INTENTIONALLY internet-facing: it is the public entry point for
# the two backend services (the services themselves are private, reachable
# only via this ALB per §D).
#tfsec:ignore:aws-elb-alb-not-public
resource "aws_lb" "this" {
  name               = "aramo-${var.environment}-alb"
  load_balancer_type = "application"
  internal           = false
  subnets            = var.public_subnet_ids
  security_groups    = [var.alb_security_group_id]

  drop_invalid_header_fields = true

  tags = merge(var.tags, { Name = "aramo-${var.environment}-alb" })
}

# -----------------------------------------------------------------------------
# Target groups — one per service, ip-target (Fargate awsvpc).
# -----------------------------------------------------------------------------
resource "aws_lb_target_group" "api" {
  name        = "aramo-${var.environment}-api"
  port        = var.api_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = var.api_health_check_path
    matcher             = var.api_health_check_matcher
    protocol            = "HTTP"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = merge(var.tags, { Name = "aramo-${var.environment}-api-tg" })
}

resource "aws_lb_target_group" "auth" {
  name        = "aramo-${var.environment}-auth"
  port        = var.auth_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = var.auth_health_check_path
    matcher             = var.auth_health_check_matcher
    protocol            = "HTTP"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = merge(var.tags, { Name = "aramo-${var.environment}-auth-tg" })
}

# -----------------------------------------------------------------------------
# HTTP listener — default → api; a rule routes auth paths → auth-service.
# -----------------------------------------------------------------------------
# HTTP :80 is the DIRECTIVE-SANCTIONED first-apply posture (§C): the ACM cert
# + HTTPS :443 listener + DNS are the EDGE directive (DNS-dependent). The ALB
# SG already permits 443, so adding the HTTPS listener later is non-structural.
#tfsec:ignore:aws-elb-http-not-used
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener_rule" "auth" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.auth.arn
  }

  condition {
    path_pattern {
      values = ["/auth", "/auth/*", "/.well-known/*"]
    }
  }
}
