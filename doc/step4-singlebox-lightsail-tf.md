# Step-4 Single-Box Directive 4 — the Lightsail Terraform

Provisions the **go-live-#1 box as code** in a **completely separate Terraform
root** ([`infrastructure-lightsail/`](../infrastructure-lightsail/)), leaving the
platform Terraform ([`infrastructure/`](../infrastructure/)) **untouched**. This
doc is the recon report (§A) and the documented manual remainder (§F).

Baseline: `main` @ `d16322b`. Branch: `feat/step4-singlebox-d4-lightsail-tf`.

---

## A. Recon (done against the real account, not assumptions)

1. **Lightsail provider capabilities** — all four resources exist in the locked
   `hashicorp/aws 5.100.0` (`~> 5.0`, same constraint as the platform root) and
   `terraform validate` + `plan` both pass:
   - `aws_lightsail_instance`, `aws_lightsail_static_ip`,
     `aws_lightsail_static_ip_attachment`, `aws_lightsail_instance_public_ports`,
     plus `aws_lightsail_key_pair`.
   - **Rough edges handled inline:** (a) `instance_public_ports` is the **full**
     firewall set — managing it takes ownership and closes Lightsail's
     default-open port 22; we list 80/443 + a restricted 22 explicitly. (b) The
     A record targets `aws_lightsail_static_ip.this.ip_address`, **not** the
     instance's `public_ip_address`, which can lag the static-IP attachment.
     (c) `key_pair` with `public_key` supplied → Lightsail does **not** generate
     a private key, so none is written to state.

2. **Bundle + blueprint (us-east-1):**
   - Bundle `medium_3_0` — **2 vCPU / 4 GB / 80 GB SSD**, $24/mo, active.
     (Chosen over `medium_ipv6_3_0` at $20: the dual-stack bundle has a public
     **IPv4**, which the static IP and Route 53 A record require.)
   - Blueprint `ubuntu_24_04` — **clean Ubuntu 24.04 LTS**, active. Deliberately
     not the OpenCATS image; the existing `opencats-astreinc` Lightsail box is
     left alone.

3. **Platform TF backend/provider pattern (mirrored, not shared):** the platform
   prod root uses `hashicorp/aws ~> 5.0`, `us-east-1`, an S3 backend
   (`bucket = aramo-terraform-state-prod`, `key = prod/terraform.tfstate`,
   `dynamodb_table = aramo-terraform-locks`, `encrypt = true`), and provider
   `default_tags` (Project/Environment/ManagedBy). This root **mirrors the
   style** — same provider version, region, S3 backend + lock table, default_tags
   — but writes to its **own key** `lightsail/terraform.tfstate` (a different
   state file → separate `apply` blast radius). No shared modules, no
   `terraform_remote_state`.

4. **`aramo.ai` Route 53 zone — IN THIS ACCOUNT (no HALT).** `list-hosted-zones`
   returns `aramo.ai.` = **`Z036386539U6ZS64ATYDK`**, public zone, account
   `472534873684`. A `data "aws_route53_zone"` lookup resolves it; `plan`
   confirms the A record binds to that zone id.

5. **SSH key pair — none exists** (`get-key-pairs` is empty). The root therefore
   **imports the PO's public key** via `aws_lightsail_key_pair.public_key` (a
   required var). Importing the public half means no private key is generated or
   stored — the PO generates the pair out-of-band (`ssh-keygen -t ed25519`).

---

## B–E. What the root builds

See [`infrastructure-lightsail/README.md`](../infrastructure-lightsail/README.md)
for the resource table. In short: the instance (us-east-1a, `medium_3_0`,
`ubuntu_24_04`), the static IP + attachment, the firewall (80/443 open, 22
restricted to a `ssh_source_cidr` var — Postgres/Redis never opened), the
`astre.aramo.ai` A record, and an **optional** `s3:PutObject`-only backup IAM
user (off by default). `user_data.sh` is secret-free OS prep (Docker + compose +
`deploy` user) — no repo clone, `.env`, deploy, or seed.

### No secret in state (§D)

The backup IAM piece creates the **user + narrow policy only**. It does **not**
create an `aws_iam_access_key` — that would persist the secret access key in
Terraform state. The key is generated out-of-band after apply:

```bash
aws iam create-access-key --user-name astre-aramo-backup-putter
```

The SSH key is handled the same way: only the **public** half enters Terraform.

---

## F. Explicitly OUT of this Terraform — the remaining manual / runbook steps

These stay out by design; they are covered by
[`doc/runbooks/singlebox-ops.md`](runbooks/singlebox-ops.md):

- **Cognito config.** Pool `us-east-1_4fKlnGfaW` was created outside Terraform
  and is **shared** across all the §5 auth work. Importing a live shared pool
  into a fresh root to add a callback URL is fiddly and risky — Terraform would
  then own it and try to drift-correct a shared pool. It stays a **manual / CLI**
  step (the runbook's §5 Cognito checklist). If ever wanted as code, use an
  `aws cognito-idp` CLI script, not a TF import.
- **`.env` secrets** — never in Terraform/state. Manual on the box, `chmod 600`.
- **The app deploy + seed** — runbook: `docker compose up`, the scrubbed Astre
  seed, the §5 login checklist.

---

## G. Provability & apply

- `terraform fmt -check` — clean.
- `terraform validate` — **Success! The configuration is valid.**
- `terraform plan` — run against live creds (account `472534873684`) with a
  local backend (so the shared S3 state is never touched): **8 to add, 0 to
  change, 0 to destroy**. The zone data source resolved to the real
  `Z036386539U6ZS64ATYDK`; the firewall plan shows 22 restricted to the supplied
  `/32` and 80/443 open.
- **The APPLY is the PO's** — his account, his creds, **real billable
  resources** (~$24/mo + the static IP). Unlike the reserved platform root, this
  root is **meant to be applied** (it is go-live #1's infra). The directive
  delivers apply-ready Terraform; the PO runs `apply`.

## Separation verified

`git status` confirms the diff is **confined to `infrastructure-lightsail/` +
this doc**. The platform `infrastructure/` is not touched — not a single file.
