# iam-certbot-dns

The least-privilege IAM principal for certbot DNS-01 challenges — Front-Door
Migration PR-0 (ADR-0023).

## Purpose

PR-2's certbot sidecar obtains the `aramo.ai` wildcard cert by solving the ACME
DNS-01 challenge — writing a `_acme-challenge.aramo.ai` TXT record into the hosted
zone. This module is the principal certbot authenticates as: an IAM **user** plus
an inline policy scoped to exactly that one write. It ships inert (no consumer
until PR-2 cutover).

## Why a user, not a role

Mirrors the `iam-app-principal` precedent: there is no compute platform in IaC for
the sidecar to assume a role from — it runs as a container on the box and
authenticates via credentials in its environment. When a compute-platform role
lands (instance profile / IRSA / task role), migrate this policy onto it and
retire the user.

## Policy shape (Ruling 2)

Two statements:

1. **`DiscoverAndPoll` (unscoped by AWS necessity):** `route53:ListHostedZones`
   + `route53:GetChange` on `"*"`. certbot's `dns-route53` plugin discovers the
   zone via `ListHostedZones` and polls propagation via `GetChange`; **neither
   action accepts a zone-scoped resource ARN**, so they cannot be narrowed. Both
   are read-only (enumerate / poll), not a write path.
2. **`WriteAcmeChallengeTxtOnly` (zone-scoped + condition-hardened):**
   `route53:ChangeResourceRecordSets` on the `aramo.ai` zone ARN only, with
   conditions `route53:ChangeResourceRecordSetsRecordTypes = ["TXT"]` and
   `route53:ChangeResourceRecordSetsNormalizedRecordNames =
   ["_acme-challenge.aramo.ai"]`.

Net: the principal can write **exactly one record name, of exactly one type, in
exactly one zone**. Tighter than the charter shorthand, not looser.

## Access keys (Ruling 3)

This module creates the user + inline policy **only** — it does **not** create
access keys (that would write the secret into Terraform state). Generate the key
out-of-band and stage it into the box `.env` per the apply runbook
(`doc/runbooks/frontdoor-pr0-apply.md`):

```
aws iam create-access-key --user-name aramo-certbot-dns
```

then wire `CERTBOT_AWS_ACCESS_KEY_ID` / `CERTBOT_AWS_SECRET_ACCESS_KEY` (the names
PR-2's compose passes through — Ruling 7). Never commit the secret.

## Outputs

- `user_name` — the IAM user name (key-generation target).
- `user_arn` — the IAM user ARN.
