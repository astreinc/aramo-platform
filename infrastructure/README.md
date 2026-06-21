# Aramo Terraform Workspace

Declarative IaC artifacts for Aramo cloud infrastructure. Anchored to
Plan v1.5 §M4 Track A item 5 ("All cloud resources expressed as
declarative IaC artifacts under version control"); see
`doc/01-locked-baselines.md` (§5).

## Directory structure

```
infrastructure/
  modules/                  # shared modules (empty at PR-8; populated in sequenced PRs)
    README.md
  environments/
    dev/                    # per-env composition: provider, backend, variables, main, tfvars.example
    staging/
    prod/
  bootstrap/                # one-time AWS resource provisioning (pre-Terraform-init)
    bootstrap.sh
    README.md
  README.md                 # this file
```

## Bootstrap protocol (run-once)

The S3 state buckets and DynamoDB lock table that back the Terraform S3
backend are NOT Terraform-managed (chicken-and-egg). They are
provisioned by `bootstrap/bootstrap.sh` once per AWS account before any
`terraform init` is run. See `bootstrap/README.md` for the run protocol.

## Environments

Three environments with separate per-environment directories (NOT
Terraform workspaces, per ADR-0012):

- `environments/dev/` — local development; rarely deployed; minimal
  AWS resources. **Data-plane-and-compute-free by design**: dev wires
  only the CloudWatch log groups (no VPC/RDS/S3/compute). Step-4
  Directive 2 therefore adds the run layer to **staging + prod only** —
  there is no data plane in dev for compute to attach to, and bloating
  dev with a full stack it never had would contradict its "minimal"
  charter. Not a gap — a deliberate per-env composition difference (the
  same reason dev has no `rds`/`vpc` today).
- `environments/staging/` — deployed; canary surface. Mirrors prod (the
  rehearsal ground for the prod apply).
- `environments/prod/` — deployed; production.

Per-env state files are keyed in S3 by directory path
(`<env>/terraform.tfstate`); the DynamoDB lock table is shared across
all environments.

## Module population sequence

PR-8 establishes the workspace foundation only. Modules are added in
sequenced PRs:

- **M4 PR-9** (observability): CloudWatch + alarms + log groups.
- **M4 PR-10** (CVE): security scanning integration; no new AWS
  resources.
- **M5**: RDS Postgres + ElastiCache Redis + SNS/SQS + IAM roles +
  networking.
- **M7**: AWS Secrets Manager + key rotation policy (Architecture
  v2.1 §12.2 signing-keys posture).
- **Step-4 Directive 2** (compute IaC): ECR + ECS/Fargate (api +
  auth-service) + ALB + least-privilege SG mesh + ElastiCache Redis +
  Secrets Manager containers + the prod IAM app principal (as ECS task
  roles, closing the recon's staging/prod gap). Account-independent
  authoring; apply gated on the account. See `doc/step4-compute-iac.md`.

## CI integration

Two CI gates at PR-8 (both run without AWS credentials):

- `terraform-fmt` — `terraform fmt -check -recursive infrastructure/`
  (idempotent formatting).
- `terraform-validate` — `terraform init -backend=false && terraform
  validate` per environment (matrix across dev / staging / prod).

Both are wired into the `deployment-gate` aggregator's `needs:` list.
Deeper gates (`tflint`, `tfsec`, `terraform plan` PR comments) are
deferred to PR-9 / PR-10.

## Local prerequisites

- Terraform `>= 1.6.0` (`brew install terraform` or `tfenv install`).
- AWS CLI v2 configured (for bootstrap and any future `terraform apply`
  work).
- AWS provider `~> 5.0` (resolved by `terraform init`).

## Conventions

See `doc/adr/0012-iac-conventions.md` for the full set of IaC
conventions decided at PR-8 (provider, state backend, workspace
structure, environment topology, bootstrap protocol, CI integration,
lock-file commitment, module-population sequence).
