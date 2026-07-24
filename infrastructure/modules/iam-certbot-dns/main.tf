# -----------------------------------------------------------------------------
# iam-certbot-dns — the least-privilege principal for certbot DNS-01 challenges.
#
# Front-Door Migration PR-0 (ADR-0023). PR-2's certbot sidecar solves the ACME
# DNS-01 challenge for the `aramo.ai` wildcard cert by writing a TXT record into
# the hosted zone. This module is the principal it authenticates as: a user + an
# inline policy scoped to exactly that one write.
#
# WHY AN IAM USER (not an assumed role): mirrors the `iam-app-principal`
# precedent. There is no compute platform in IaC for the certbot sidecar to
# assume a role from — it runs as a container on the box and authenticates via
# credentials in its environment. So the interim least-privilege principal is a
# scoped IAM user. If we ever move to a compute-platform role (instance profile /
# IRSA / task role), MIGRATE this policy onto that role and retire the user.
#
# SECRETS (Ruling 3): this module creates the user + the inline scoped policy
# ONLY. It does NOT create access keys — generating them here would write the
# secret into Terraform state. Generate the access key out-of-band and stage it
# into the box `.env` (never committed):
#   aws iam create-access-key --user-name aramo-certbot-dns
# then wire CERTBOT_AWS_ACCESS_KEY_ID / CERTBOT_AWS_SECRET_ACCESS_KEY per the
# §4 runbook (doc/runbooks/frontdoor-pr0-apply.md).
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

# PR-0b (R2) — the hosted-zone lookup lives HERE, with its only consumer (the
# certbot policy needs the zone ARN). Read-only data source; greenfield posture
# unchanged (no managed zone — the zone predates IaC). The `aramo.ai` apex belongs
# to the PublicSite track and is out of scope for this migration; this module reads
# the zone solely to scope the ChangeResourceRecordSets ARN.
data "aws_route53_zone" "this" {
  name         = var.zone_name
  private_zone = false
}

# Ruling 2 — the certbot policy, two statements.
data "aws_iam_policy_document" "certbot" {
  # Ruling 2 (ADR-0023 / PR-0 directive): route53:ListHostedZones + route53:GetChange
  # accept no zone-scoped resource ARN — "*" is AWS necessity, read-only discovery.
  # Write access is separately conditioned: ChangeResourceRecordSets zone-scoped,
  # TXT-only, _acme-challenge.aramo.ai-only (statement 2).
  statement {
    sid       = "DiscoverAndPoll"
    effect    = "Allow"
    actions   = ["route53:ListHostedZones", "route53:GetChange"]
    resources = ["*"] #tfsec:ignore:aws-iam-no-policy-wildcards
  }

  # Statement 2 — the single write, zone-scoped AND condition-hardened. The
  # principal can write exactly one record name, of exactly one type, in exactly
  # one zone: the `_acme-challenge.aramo.ai` TXT. The wildcard `*.aramo.ai` SAN
  # and the apex share this one challenge name, so one name covers both.
  statement {
    sid       = "WriteAcmeChallengeTxtOnly"
    effect    = "Allow"
    actions   = ["route53:ChangeResourceRecordSets"]
    resources = ["arn:aws:route53:::hostedzone/${data.aws_route53_zone.this.zone_id}"]

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsRecordTypes"
      values   = ["TXT"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsNormalizedRecordNames"
      values   = [var.record_name]
    }
  }
}

resource "aws_iam_user" "this" {
  name = var.name
  path = "/aramo/frontdoor/"

  tags = merge(var.tags, {
    Name    = var.name
    Purpose = "certbot-dns01-acme"
  })
}

# Inline (1:1 with this user — the policy is meaningless without the user, so
# inline keeps them lifecycle-bound). Name per Ruling 3.
resource "aws_iam_user_policy" "acme_challenge" {
  name   = "${var.name}-acme-challenge"
  user   = aws_iam_user.this.name
  policy = data.aws_iam_policy_document.certbot.json
}
