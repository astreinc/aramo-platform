# Front-Door PR-0 — Apply Runbook

**Directive:** `Aramo-FrontDoor-PR-0-Directive-v1_0-LOCKED` + `…PR-0b…` (ADR-0023).
**Posture:** `terraform plan`/`apply` run **from the Mac only** (infra-account
identity — the box gets 403 on the state bucket; never run Terraform from the
box). Apply runs **AFTER merge** (the merge is an apply precondition, not the
reverse). This track writes **NO DNS** — it provisions the certbot IAM principal
only (PR-0b removed the apex record; the apex belongs to the PublicSite track).

**Wildcard preservation:** the manual `*.aramo.ai` wildcard `A` record (pre-IaC,
what tenant routing rides on) is **out of scope** — it is not managed by this
track's Terraform and must not be touched.

Each step is gated on the previous. HALT means stop and report — never improvise.

---

## 1. Context guard

- On the Mac: `uname` returns `Darwin`.
- Infra-account identity is active: `aws sts get-caller-identity` — confirm the
  account is the **infra** account. **HALT** if it resolves to the app-creds
  account (wrong identity — the hosted zone and IAM user live in the infra
  account).
- The repo is at the merged `origin/main` that contains this PR.

## 2. Plan · **HALT gate**

```
cd infrastructure/environments/prod
terraform init
terraform plan
```

Expected plan: **2 to add, 0 to change, 0 to destroy** — exactly these two
resources:

- `module.certbot_dns.aws_iam_user.this`
- `module.certbot_dns.aws_iam_user_policy.acme_challenge`

(The `aws_route53_zone` and `aws_iam_policy_document` data sources are reads, not
adds — no DNS record is created.) **HALT if the plan shows anything beyond exactly
these 2 adds.**

## 3. Apply

```
terraform apply   # apply the reviewed plan from step 2
```

## 4. Verify

- `aws iam get-user --user-name aramo-certbot-dns` returns 0.

## 5. Key generation — out-of-band (Ruling 3)

```
aws iam create-access-key --user-name aramo-certbot-dns
```

Record the pair **ONLY** into the box `.env` staging area. Never commit it, never
paste it into chat or a directive.

## 6. Deploy-path contract (Ruling 7)

Append the two entries to the box `.env`:

```
CERTBOT_AWS_ACCESS_KEY_ID=<from step 5>
CERTBOT_AWS_SECRET_ACCESS_KEY=<from step 5>
```

Values live now; the consumer arrives at the PR-2 cutover. An unreferenced `.env`
entry is inert-safe; an unwired sidecar is not — PR-2's compose **MUST** pass
these exact names through, and the PR-2 directive **MUST** cite Ruling 7 when it
wires them. (Names final unless the PR-2 directive rules otherwise, in which case
PR-2 amends this runbook in the same PR.)
