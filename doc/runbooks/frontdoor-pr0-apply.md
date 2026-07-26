# Front-Door PR-0 — Apply Runbook

**Directive:** `Aramo-FrontDoor-PR-0-Directive-v1_0-LOCKED` + `…PR-0b…` + `…PR-0c…`
(ADR-0023). PR-0c re-homed the certbot IAM principal from the dormant
`infrastructure/environments/prod` root to the LIVE `infrastructure-lightsail/`
root (E13) — this runbook applies from there.
**Posture:** `terraform plan`/`apply` run **from the Mac only** (infra-account
identity — the box gets 403 on the state bucket; never run Terraform from the
box). Apply runs **AFTER merge** (the merge is an apply precondition, not the
reverse). This apply **adds only the certbot IAM principal** — it writes **no
DNS**; the root's existing DNS records (and every other existing resource) must
plan **clean** (§2).

**Wildcard custody (E14):** the `*.aramo.ai` wildcard `A` record is **Terraform-
managed by this root** (`aws_route53_record.wildcard` in
`infrastructure-lightsail/main.tf`) — it is NOT a manual/pre-IaC record. The
preservation posture is unchanged: this procedure adds only the certbot IAM
resources and touches nothing existing, so the wildcard (like all existing
resources) must show **no change** in the plan.

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
cd infrastructure-lightsail
terraform init
terraform plan
```

Expected plan: **exactly `2 to add, 0 to change, 0 to destroy`** — exactly these
two resources added:

- `module.certbot_dns.aws_iam_user.this`
- `module.certbot_dns.aws_iam_user_policy.acme_challenge`

(The `aws_route53_zone` and `aws_iam_policy_document` data sources are reads, not
adds — no DNS record is created.)

**Existing-resource guard — HALT on ANY change/replace/destroy** to the root's
already-applied resources; the plan must show them untouched:

- `aws_lightsail_instance.this`, `aws_lightsail_static_ip.this`,
  `aws_lightsail_static_ip_attachment.this`
- `aws_lightsail_instance_public_ports.this` (the public 80/443 ports)
- `aws_route53_record.app` **and** `aws_route53_record.wildcard`
- `aws_iam_user.backup` / `aws_iam_user_policy.backup` (if backup IAM is enabled)

Any `~ update`, `-/+ replace`, or `- destroy` on the above is **provider drift**
— **HALT and paste the plan verbatim.** Do not apply.

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
