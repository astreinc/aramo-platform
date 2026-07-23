# Aramo PUB-1 PR-1b (§3.2 / Amendment v1.1 G0-R2) — public-site environment root.
#
# The FIRST Terraform managing LIVE Aramo infrastructure (the aramo.ai zone is
# real and pre-existing). Apply is PO-lane from the Mac (infra account), never
# CI, never the box. See README.md for the pre-apply checklist.

locals {
  common_tags = {}
}

module "public_site" {
  source = "../../modules/lightsail-static-site"

  instance_name     = "aramo-public-site"
  availability_zone = var.availability_zone
  blueprint_id      = var.blueprint_id
  bundle_id         = var.bundle_id
  tags              = local.common_tags
}

# The aramo.ai hosted zone is LIVE and pre-existing — a DATA source, NEVER a
# resource (Terraform must not create or own the zone). The explicit A records
# below override any pre-existing `*.aramo.ai` wildcard for these three names.
data "aws_route53_zone" "aramo" {
  name         = "aramo.ai."
  private_zone = false
}

# G0-R3 serving posture: apex + www + staging all point at the one static IP
# (nothing answers until the host is brought up and deployed — acceptable).
# Default posture is the holding page; if the PO vetoes to keep the apex dark
# until launch, these become flag-gated (see README + the Gate-5 report).
resource "aws_route53_record" "apex" {
  zone_id = data.aws_route53_zone.aramo.zone_id
  name    = "aramo.ai"
  type    = "A"
  ttl     = 300
  records = [module.public_site.static_ip]
}

resource "aws_route53_record" "www" {
  zone_id = data.aws_route53_zone.aramo.zone_id
  name    = "www.aramo.ai"
  type    = "A"
  ttl     = 300
  records = [module.public_site.static_ip]
}

resource "aws_route53_record" "staging" {
  zone_id = data.aws_route53_zone.aramo.zone_id
  name    = "staging.aramo.ai"
  type    = "A"
  ttl     = 300
  records = [module.public_site.static_ip]
}
