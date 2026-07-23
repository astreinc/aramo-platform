# Front-Door PR-0 — Apply Runbook

**Directive:** `Aramo-FrontDoor-PR-0-Directive-v1_0-LOCKED` (ADR-0023).
**Posture:** `terraform plan`/`apply` run **from the Mac only** (infra-account
identity — the box gets 403 on the state bucket; never run Terraform from the
box). Apply runs **AFTER merge** (Ruling 8): the merge is an apply precondition,
not the reverse.

Each step is gated on the previous. HALT means stop and report — never improvise.

---

## 1. Context guard

- On the Mac: `uname` returns `Darwin`.
- Infra-account identity is active: `aws sts get-caller-identity` — confirm the
  account is the **infra** account. **HALT** if it resolves to the app-creds
  account (wrong identity — the hosted zone and IAM user live in the infra
  account).
- The repo is at the merged `origin/main` that contains this PR.

## 2. Preflight — apex record (Ruling 5) · **HALT gate**

List the apex record sets in the `aramo.ai` zone:

```
ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name aramo.ai \
  --query 'HostedZones[0].Id' --output text)
aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" \
  --query "ResourceRecordSets[?Name=='aramo.ai.']"
```

**HALT on any existing apex `A`/`AAAA`/`CNAME`/alias record.** Terraform must not
clobber a pre-existing apex site. Expected result today: none (P1 established no
apex site exists).

## 3. Plan · **HALT gate**

```
cd infrastructure/environments/prod
terraform init
terraform plan
```

Expected plan: **3 to add, 0 to change, 0 to destroy** — exactly these three
resources:

- `module.route53_apex.aws_route53_record.apex`
- `module.certbot_dns.aws_iam_user.this`
- `module.certbot_dns.aws_iam_user_policy.acme_challenge`

(The `aws_route53_zone` and `aws_iam_policy_document` data sources are reads, not
adds.) **HALT if the plan shows anything beyond exactly these 3 adds.**

## 4. Apply

```
terraform apply   # apply the reviewed plan from step 3
```

## 5. Verify

- `dig +short aramo.ai A` returns the box IP (allow for DNS propagation).
- `aws iam get-user --user-name aramo-certbot-dns` returns 0.

## 6. Key generation — out-of-band (Ruling 3)

```
aws iam create-access-key --user-name aramo-certbot-dns
```

Record the pair **ONLY** into the box `.env` staging area. Never commit it, never
paste it into chat or a directive.

## 7. Deploy-path contract (Ruling 7)

Append the two entries to the box `.env`:

```
CERTBOT_AWS_ACCESS_KEY_ID=<from step 6>
CERTBOT_AWS_SECRET_ACCESS_KEY=<from step 6>
```

Values live now; the consumer arrives at the PR-2 cutover. An unreferenced `.env`
entry is inert-safe; an unwired sidecar is not — PR-2's compose **MUST** pass
these exact names through, and the PR-2 directive **MUST** cite Ruling 7 when it
wires them. (Names final unless the PR-2 directive rules otherwise, in which case
PR-2 amends this runbook in the same PR.)
