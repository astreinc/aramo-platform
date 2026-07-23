# route53-apex

The apex `A` record for `aramo.ai` — Front-Door Migration PR-0 (ADR-0023).

## Purpose

Points `aramo.ai` at the box's Lightsail static IP so the apex privacy page and
PR-2's certbot DNS-01 challenge have a live name to work with. It is the smallest
DNS increment that unblocks the front-door migration; nothing in the running
front door depends on it (it ships inert).

## Zone posture (Ruling 4)

The `aramo.ai` hosted zone **predates IaC and stays unmanaged** — greenfield
posture, no import of manually-created infra (ADR-0012 Decision 9). This module
reads the zone via `data "aws_route53_zone"` (`private_zone = false`) and creates
**only** the apex `A` record within it. It never manages the zone itself.

## Apex record shape (Ruling 5)

- `A` record, `aramo.ai` → `var.apex_ip`, TTL `var.ttl` (default 300).
- No `AAAA` (the box has no IPv6 endpoint in service), no `www` CNAME
  (out of charter scope).

## Preflight halt (Ruling 5)

Before `terraform apply`, the apply runbook
(`doc/runbooks/frontdoor-pr0-apply.md`) lists the apex record sets and **HALTs if
any existing apex `A`/`AAAA`/`CNAME`/alias record is present** — Terraform must
not clobber a pre-existing apex site. Expected result today: none (P1 established
no apex site exists).

## Outputs

- `zone_id` — the hosted-zone id (feeds `iam-certbot-dns`).
- `apex_fqdn` — the fully-qualified apex name.
