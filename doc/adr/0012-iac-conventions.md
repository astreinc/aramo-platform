# ADR-0012: IaC Conventions (Terraform Workspace, AWS Provider, S3+DynamoDB Backend, CI Integration)

**Status:** Accepted

**Date:** 2026-05-23

---

## Context

Plan v1.5 §M4 Track A item 5 commits the Aramo program to expressing all cloud resources as declarative IaC artifacts under version control. The in-repo anchor for this commitment is `doc/01-locked-baselines.md:114`; the canonical anchor is `Aramo-Phase-1-Delivery-Plan-v1.5-LOCKED.docx` (sha256 `d2e62ffb…cc472e`). The M4 PR-8 Substrate Audit + Re-run (HEAD `8fb03d3`) confirmed comprehensive IaC substrate absence at the audit baseline: zero `*.tf` files, zero `terraform/` directories, no `.gitignore` IaC patterns. The audit also confirmed AWS as the canonical cloud provider via six independent in-repo anchors (Architecture §5 stack, ADR-0001, M0/M1 closure records, M0/M1 refusal sign-offs), and surfaced eight open Lead rulings (Q0–Q8) governing PR-8 scope.

This ADR locks the conventions decided at PR-8 — the program's first IaC substrate. Without explicit doctrine, PR-9 (observability), PR-10 (CVE), and M5 (RDS/ElastiCache/SNS+SQS/IAM/networking) implementers would face concrete questions ("which Terraform version line do I pin?", "do I add a new environment directory or extend a shared workspace?", "are lock files committed?", "do I add a `tflint` job here or defer?") and would answer them by guessing, re-deriving, or blocking on the Lead. Per `doc/04-risks.md` CX2, ADRs are the named mitigation for forgotten architectural rationale; per D4, an ADR locks the pattern before parallel PRs invent variants.

PR-8 is the program's first foundation-laying greenfield substrate work (audit §J Q3 + M0 PR-M0R-3 aggregator-only precedent). This ADR captures the nine §2 scope rulings from the M4 PR-8 Directive (sha256 `85416be8…f541`) as the doctrine PR-9+ implementers reference.

---

## Decision

### Decision 1 — Cloud provider: AWS

The Aramo cloud substrate is AWS. The Terraform AWS provider is pinned with `version = "~> 5.0"` and `source = "hashicorp/aws"`. The required Terraform binary is `>= 1.6.0`.

**Why.** AWS is canonical via six independent in-repo anchors: Architecture §5 names PostgreSQL/RDS, Redis/ElastiCache, AWS S3, SNS+SQS, AWS Secrets Manager; ADR-0001 names AWS RDS as the production Postgres host; M0 / M1 closure records and refusal sign-offs name AWS Secrets Manager as the M7 signing-key target (Architecture v2.1 §12.2). The audit (§D.14) confirmed this is a resolved commitment, not an open ruling. No alternative-provider work is in scope for PR-8 or any sequenced subsequent PR through M7.

**Constraint preserved.** Provider configuration is identical across all three environment directories. Region defaults to `us-east-1` per the Architecture §5 stack; per-environment region overrides are possible via `aws_region` variable but not exercised at PR-8.

---

### Decision 2 — State backend: S3 + DynamoDB lock

Each environment's `backend.tf` declares an S3 backend with a DynamoDB lock table. Per-environment S3 buckets (`aramo-terraform-state-dev`, `aramo-terraform-state-staging`, `aramo-terraform-state-prod`) hold separate state files keyed by directory path (`<env>/terraform.tfstate`). The DynamoDB lock table (`aramo-terraform-locks`) is shared across all environments. State encryption is enabled (`encrypt = true`); buckets enforce server-side AES256 encryption, public-access blocking, and versioning.

**Why.** S3 + DynamoDB lock is the AWS-canonical Terraform backend and is widely deployed. The three reasons cited in the directive (Ruling 2):

- AWS-canonical Terraform backend; widely-deployed pattern.
- No new vendor commitment (stays within AWS service inventory established by Architecture §5).
- Bootstrap-friendly: an S3 bucket and a DynamoDB table are the minimum new AWS resources required, and both are provisionable via a one-time pre-Terraform script.

**Rejected alternatives.** HCP Terraform managed (new vendor); Spacelift (new vendor); Atlantis (additional self-hosted infrastructure overhead). All three add governance, billing, and operational surface area that the AWS-canonical pattern avoids.

---

### Decision 3 — Bootstrap protocol: one-time pre-Terraform-init script

The S3 buckets + DynamoDB lock table that back the Terraform S3 backend are NOT Terraform-managed. They are provisioned by `infrastructure/bootstrap/bootstrap.sh` once per AWS account, before any `terraform init` is run. The script is committed to the repository with a `README.md` documenting the run-once protocol.

**Why.** Chicken-and-egg: the backend resources cannot be created by Terraform because Terraform needs them to exist before `init` succeeds. Importing the backend resources into the state they manage post-creation (`terraform import`) is fragile — any state corruption that necessitates manual recovery requires re-running the bootstrap path anyway. The standard industry pattern is bootstrap-outside-Terraform, with the bootstrap step documented as a one-time prerequisite.

**Idempotency.** The bootstrap script is deliberately NOT idempotent. Re-running fails with `BucketAlreadyOwned` errors, which is the desired safety: state buckets should never be silently re-created. The README documents this explicitly.

---

### Decision 4 — PR-8 scope: option γ (minimum viable IaC foundation)

PR-8 ships substrate only — provider configuration, state backend configuration, empty `modules/` directory, environment composition skeleton (3 env directories, each with `provider.tf` + `backend.tf` + `variables.tf` + `main.tf` placeholder + `terraform.tfvars.example`), bootstrap script + README, ADR-0012, and CI integration (fmt + validate). NO resource definitions beyond the minimum needed to make the workspace valid. Module population (Postgres, Redis, networking, IAM, secrets, etc.) is deferred to PR-9 / PR-10 / M5.

**Why.** M0 PR-M0R-3 deployment-gate precedent: the substrate-establishing PR is aggregator-only with no deploy step, sequenced before the gates it aggregates have content. Applied here: PR-8 establishes the IaC substrate; module-population PRs add the content the substrate organizes. The decoupling preserves verification signal — a CI failure at PR-8 is a substrate-shape problem, not a module-shape problem; future module PRs can focus on resource correctness without re-debating workspace structure.

**Rejected alternatives.**
- **Option α (full IaC foundation with all baseline modules):** too heavy; muddies verification signal; conflates substrate decisions with module decisions; would inflate PR-8 line count by an order of magnitude.
- **Option β (substrate + one module):** commits to a module shape before module decisions are fully thought through; the "which module" choice itself becomes a scope question that doesn't belong in foundation work.

---

### Decision 5 — Environment topology: 3 environments (dev / staging / prod), separate per-environment directories

Three environment directories under `infrastructure/environments/`: `dev/`, `staging/`, `prod/`. Each is a standalone Terraform workspace root with its own `provider.tf`, `backend.tf`, `variables.tf`, `main.tf` (placeholder at PR-8), and `terraform.tfvars.example`. State files are per-env, keyed in S3 by directory path. The DynamoDB lock table is shared.

**Why.** Three reasons (Ruling 5):

- **Separate directories are explicit; easier to reason about; no implicit-context-switch errors.** With Terraform workspaces, `terraform workspace select` changes which state the same files mutate — an easy class of operator error. Separate directories make the deployment target obvious from `cwd`.
- **Per-env state file in S3 backend** keyed by directory path (`<env>/terraform.tfstate`); shared DynamoDB lock table. This separation isolates blast radius (a corrupted dev state cannot affect prod) while keeping lock-table operational surface area minimal.
- **3 environments is standard:** dev (Testcontainers + local; rarely deployed; minimal AWS resources), staging (deployed; canary surface), prod (deployed; production).

**Rejected alternative.** Terraform workspaces (`terraform workspace new`). The implicit-context-switch error class outweighs the small file-duplication cost of separate directories at three environments.

**Constraint preserved.** AWS account separation per environment is OUT of M4 scope (M5 or later); all three environments share an AWS account at PR-8.

---

### Decision 6 — CI integration scope at PR-8: terraform fmt + terraform validate only

Two new CI jobs are added at PR-8:

- **`terraform-fmt`** — runs `terraform fmt -check -recursive infrastructure/`. No matrix; runs once. No AWS credentials required.
- **`terraform-validate`** — runs `terraform init -backend=false && terraform validate` per environment as a matrix across `dev / staging / prod`. The `-backend=false` flag skips state backend init; no AWS credentials required.

Both jobs are wired into the `deployment-gate` aggregator's `needs:` list (extending from 13 to 15 dependencies). The CI workflow grows from 19 jobs to 21.

**Why.** PR-8 ships substrate, not deployed resources. `terraform fmt` enforces formatting discipline (cheap, deterministic). `terraform validate` enforces per-environment validity (catches `.tf` syntax + provider-schema errors). Both run without AWS credentials, which avoids escalating CI permission surface area for a substrate-only PR. Heavier gates (`tflint`, `tfsec` / `checkov`, `terraform plan` PR-comment integration) require either credentials or substantive scope and are deferred to PR-9 (observability) / PR-10 (CVE).

**Lock file commitment.** `.terraform.lock.hcl` files ARE committed (standard Terraform best practice — ensures provider version consistency across team + CI). `.gitignore` excludes the `.terraform/` cache directory but NOT `.terraform.lock.hcl`.

---

### Decision 7 — Workspace structure: `modules/` + `environments/<env>/` separation

`infrastructure/modules/` holds shared modules; `infrastructure/environments/<env>/` holds per-environment composition (which modules to instantiate, with what variables, into what state). At PR-8 the `modules/` directory is empty with a README documenting the population sequence; environment directories instantiate no modules.

**Why.** Industry-standard Terraform workspace layout. Separation of "what is the resource shape" (modules) from "where and with what variables is it deployed" (environments) is the canonical Terraform pattern; mirrors Architecture §7's schema-per-module + per-environment-composition posture for Postgres.

**Module population precedence.** Modules are added in this sequence:
- M4 PR-9 (observability): CloudWatch + alarms + log groups.
- M4 PR-10 (CVE): security scanning integration; no new AWS resources.
- M5: RDS Postgres + ElastiCache Redis + SNS/SQS + IAM roles + networking.
- M7: AWS Secrets Manager + key rotation policy.

---

### Decision 8 — IaC vocabulary discipline scope

`scripts/verify-vocabulary.sh` two-tier discipline (Tier 1 R7 LinkedIn allowlist; Tier 2 candidate / customer / outreach / evaluation / submission / score / rank) extends to new `.tf` files. Terraform identifiers (resource names, variable names, module names) are infrastructural and do not intersect product-domain vocabulary — substrate-natural pass at PR-8.

**Why.** Audit §Q7 confirmed. Aramo locked vocabulary applies to all source under the workspace; infrastructure source is no exception. PR-8 introduces no terms that intersect Tier 1 or Tier 2; future module-population PRs (PR-9+) should re-verify.

**No `TIER2_EXCLUDES` extension.** Substrate-natural pass; no `.tf`-specific exclusion required.

---

### Decision 9 — No `terraform import` greenfield posture

The Aramo runtime substrate is Testcontainers-only at HEAD `8fb03d3` (audit §Q6 confirmed). No long-running AWS resources exist to capture into Terraform state via `terraform import`. PR-8 ships entirely greenfield; module-population PRs from PR-9 onward create new AWS resources cleanly rather than importing pre-existing ones.

**Why.** The audit confirmed there is no manually-provisioned dev infrastructure to migrate. The Testcontainers-only runtime substrate means the first `terraform apply` (M5 territory) creates AWS resources for the first time; no import work is required.

**Implication for M7 AUTH-HARD carry-forward.** `AUTH_PRIVATE_KEY` / `AUTH_PUBLIC_KEY` migration to AWS Secrets Manager (carried from M0 / M1) creates fresh secrets in Secrets Manager; the env-var-stored keys are not imported into Terraform state.

---

## Consequences

### Positive

- Plan v1.5 §M4 Track A item 5 ("declarative IaC artifacts under version control") is materially satisfied at PR-8 in foundation form; module-population PRs extend it without re-debating substrate.
- Workspace structure mirrors industry-standard Terraform pattern (`modules/` + `environments/<env>/`); onboarding ramp for new contributors is minimized.
- State backend choice (S3 + DynamoDB lock) is AWS-canonical and widely-deployed; no new vendor billing, governance, or operational surface area.
- CI integration is bounded and credential-free at PR-8 (fmt + validate only); deeper gates are deferred until they're needed and the credential plumbing exists.
- Lock files are committed: provider version drift between team members and CI is prevented.
- The bootstrap-outside-Terraform pattern preserves a clean separation between backend-creation (one-time, manual, audited) and state-modification (Terraform-managed, frequent).
- Module-population PRs (PR-9, PR-10, M5, M7) can focus exclusively on resource shapes without re-debating provider, backend, environment topology, or CI integration.

### Negative

- Three environment directories duplicate `provider.tf`, `backend.tf`, and `variables.tf` content. At three environments the duplication cost is modest; if environment count grows beyond five, a shared-module-with-per-env-wrapper pattern may become preferable. ADR-0012 explicitly does NOT lock against that future evolution.
- The bootstrap script is non-idempotent by design. Operators who re-run it (e.g., in a fresh AWS account) without reading the README will see confusing `BucketAlreadyOwned` errors. The README's "Idempotency" section mitigates but does not eliminate this risk.
- `terraform fmt -check` failures in CI are not auto-fixed; contributors must run `terraform fmt` locally and re-commit. This is the same friction class as `npm run lint` failures and is consistent with workspace-wide pre-merge discipline.
- AWS credentials are NOT wired into CI at PR-8. `terraform plan` PR-comment integration (which would surface infrastructure drift on every PR) is deferred to PR-9+. Until then, drift is detected only at `terraform apply` time (M5+).

### Neutral

- The choice to use separate per-environment directories rather than Terraform workspaces is not reversible cheaply; switching mid-program would require state-file relocation. The directive's three-reason justification (explicit context, blast-radius isolation, standard pattern) is durable.
- The `aws_region` variable defaults to `us-east-1` per Architecture §5; per-environment region overrides are possible via `terraform.tfvars` but are not exercised at PR-8 and are out of M4 scope.
- The `default_tags` block in `provider.tf` applies `Project = "Aramo"`, `Environment = var.environment`, `ManagedBy = "Terraform"` to every AWS resource created by future modules. This is workspace-wide policy at PR-8 and is intentionally not configurable per module; if a future module needs additional tags, they layer on top of the defaults.
- ADR-0003 ("Infrastructure Conventions: Prisma 7 + Build/CI Patterns") covers build-time / dev-time infrastructure (Prisma client generation, Nx workspace mechanics). ADR-0012 covers deployed-cloud infrastructure. The two ADRs are complementary and non-overlapping; both occupy the "infrastructure conventions" namespace at different scopes.
