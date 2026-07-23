# -----------------------------------------------------------------------------
# route53-apex — the apex A record for aramo.ai.
#
# Front-Door Migration PR-0 (ADR-0023). This module owns exactly one thing: the
# apex `A` record pointing `aramo.ai` at the box's Lightsail static IP. It ships
# inert relative to the running front door — no nginx, no cert issuance, no Caddy
# change depends on it; it unblocks PR-2's certbot DNS-01 (which validates against
# the same hosted zone) and the apex privacy page.
#
# ZONE IS A DATA SOURCE, NOT A MANAGED RESOURCE (Ruling 4): the `aramo.ai` hosted
# zone predates IaC and stays unmanaged (ADR-0012 Decision 9 greenfield posture —
# no import of manual infra). This module READS the zone and creates ONLY the
# apex record within it.
#
# PREFLIGHT (Ruling 5): before apply, the runbook lists the apex record sets and
# HALTs if any apex A/AAAA/CNAME/alias already exists — Terraform will not clobber
# a pre-existing apex site. Expected today: none (P1 established no apex site).
# -----------------------------------------------------------------------------

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Ruling 4 — read the unmanaged, pre-existing public hosted zone by name.
data "aws_route53_zone" "this" {
  name         = var.zone_name
  private_zone = false
}

# Ruling 5 — the apex A record only. No AAAA (box has no IPv6 endpoint in
# service), no www CNAME (out of charter scope; PublicSite proper decides later).
resource "aws_route53_record" "apex" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = data.aws_route53_zone.this.name
  type    = "A"
  ttl     = var.ttl
  records = [var.apex_ip]
}
