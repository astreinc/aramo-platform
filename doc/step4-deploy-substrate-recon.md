# Step 4 (PROD-Deploy) — Substrate Recon

**Version 1.0** · Baseline: origin/main `de512f8` · **READ-ONLY recon — no edits, no build.**
Scope: deploy / config / tenancy-resolution / migration substrate, so the Lead can sequence Step-4 build directives against truth.

---

## TL;DR / FLAGS (read first)

- **★ IaC EXISTS — and it surprised the prompt's framing.** There IS Terraform under `infrastructure/` (3 env workspaces `dev`/`staging`/`prod` + 5 modules). It models the **data plane only** — VPC, RDS, S3 résumé bucket, CloudWatch log groups, one IAM app-*user*. It does **NOT** model: any **compute platform** (no ECS/EKS/Fargate/Lambda/App Runner), **Cognito** (zero `cognito` in `*.tf`), or **Redis/ElastiCache**. So "deploy" is half-built: storage/network/db substrate is coded; *nothing runs the apps or applies migrations.*
- **★ No Dockerfiles anywhere.** Not for `api`, `auth-service`, `ats-web`, or db. Apps run today as **plain `node dist/...` background processes** (local-stack) — there is no container image, no registry (no ECR/dockerhub), no image build/push in CI. This is the single biggest packaging gap for a prod deploy.
- **★ No deploy mechanism at all.** The only CI workflow (`.github/workflows/ci.yml`) is build/test/lint/validate. No `terraform apply`/`plan`, no migration apply, no image push, no environment promotion. The `terraform:*` jobs are static checks run with `-backend=false`/no creds.
- **★ Tenant resolution is ALREADY fully JWT-driven.** `astre.aramo.ai` is **cosmetic/routing-only** — subdomain→tenant resolution is a **no-op build**, not a real one. Host/subdomain is never read anywhere (backend or FE). *Caveat:* there is no enforcement that the host agrees with the token's tenant — that check would be net-new if wanted (NOT required for isolation).
- **★ No production migration-apply path exists.** Dev uses a bespoke raw-SQL replayer (`tools/db-sync-local.sh`, non-Prisma `_local_migrations` tracking); tests use per-spec curated `$executeRawUnsafe` lists. `prisma migrate deploy` appears only in **comments**, never executed. A prod applier must be built (and must run **inside the VPC** — RDS is `publicly_accessible=false`).
- **★ Cognito is out-of-band, not IaC.** Pools, app clients, hosted-UI domain, and the **D6 MFA pool policy** (`set-user-pool-mfa-config`) are all manual. Moving to a prod AWS account = recreate/configure all of this by hand in the new account.
- **★ Hygiene:** a real `AKIA…` access key sits in the developer's gitignored local `.env` — **rotate/scope before the prod-account migration.** App-code itself has zero hardcoded keys (clean default-credential-chain everywhere).
- **Good news:** logical pooled isolation is clean (no infra-per-tenant); config surface is fully env-driven in shipped code (no hardcoded localhost outside dev/test files); the D3 redirect/sign-out URLs are all env-throw-if-unset.

---

## 1. DEPLOY / CI-CD — what exists today

### CI/CD workflows
**One** workflow: `.github/workflows/ci.yml` (name `ci`). Triggers: `push`→`main` and `pull_request` (all branches), concurrency-grouped, cancel-in-progress. **No** `workflow_dispatch`/`schedule`/`release`/tag triggers. Other `.github/` files are non-workflow: `CODEOWNERS`, `dependabot.yml`, `npm-audit-allowlist.json`.

Jobs (all build/test/validate — **none deploy**): `install`, `prisma:validate`, `lint`, `build`, `test:unit`, `openapi:validate|lint|drift-check`, `lint:nx-boundaries`, `verify:vocabulary`, `portal/ats/ingestion:refusal-check`, `version:sync-check`, `error-codes:check`, `pact:consumer|provider`, `tests:integration` (vitest, `ARAMO_RUN_INTEGRATION=1`), `terraform:fmt|validate|lint|sec`, `npm:audit`, and `deployment-gate`.

> The `terraform:validate` job runs a `[dev, staging, prod]` matrix with `terraform init -backend=false && terraform validate` — **no AWS creds, no plan, no apply** (static syntax/security checks only; `tfsec` at `--minimum-severity=HIGH`).

### The "deployment-gate"
It is an **in-CI aggregator job** (`ci.yml:464-533`), **not** a separate workflow and **not** an actual deploy. Runs `if: always()`, lists ~18 CI jobs as `needs:`, and fails if any did not succeed — so GitHub branch-protection can require one status check. Supports an override path: PR label `override:ok-to-merge` + an `Override-Justification:` body line ≥40 chars.

- **Source of the concept:** Architecture v2.0/v2.1 **§19.2 "Deployment Gates,"** quoted verbatim in `doc/01-locked-baselines.md:164-187`. The locked 7 gates: unit / integration / contract tests, migration dry-run, security scan, OpenAPI diff reviewed, module-boundary checks. Also referenced in ADRs 0012/0013/0014.
- **It is a pre-merge CI status check.** The actual production-deploy mechanism it is *meant to gate* **does not exist in the repo.** A separate `deployment-gate.yml` was the directive's first choice but was rejected (GitHub Actions has no cross-workflow `needs:`); the in-`ci.yml` aggregator was authorized as functionally identical.

### Build / packaging beyond D5 docker-compose
- **No Dockerfiles** (production or otherwise) anywhere. No `api`/`auth-service`/`ats-web`/db image. By design, apps run via `node dist/...` + `nx serve` (`docker-compose.yml:1-6`, `tools/local-stack.sh:5-6,18-19`).
- **No container registry** (no ECR / `*.dkr.ecr.*` / dockerhub) and **no compute deploy target provisioned.** Explicit in `infrastructure/modules/iam-app-principal/main.tf:10-15` + README: *"no ECS task role, no EKS/IRSA, no instance profile … When a compute platform lands, MIGRATE to an instance/task role."* VPC README defers the AWS deployment target to "M5-close OR M6."
- **Deploy scripts:** none for the app. Scripts present are CI/dev/local only: `scripts/audit-check.sh`, `scripts/verify-vocabulary.sh`, `ci/scripts/*.ts`, `tools/*` (all local-dev/e2e), `infrastructure/bootstrap/bootstrap.sh` (run-once TF state backend: S3 state buckets + DynamoDB lock table), `infrastructure/bootstrap/create-anthropic-secret.sh` (seeds Anthropic key into Secrets Manager).

### IaC — Terraform (the only IaC; **present, partial**)
Root `infrastructure/`. `hashicorp/aws ~> 5.0`, `terraform >= 1.6.0`. State backend = per-env S3 bucket `aramo-terraform-state-<env>` + shared DynamoDB lock table `aramo-terraform-locks`, `us-east-1`.

**3 env workspaces** (`environments/{dev,staging,prod}/` — each has `backend.tf`, `provider.tf`, `variables.tf`, `main.tf`, `terraform.tfvars.example`). Composition **differs by env** (key finding):

| Env | Modules wired | Notes |
|---|---|---|
| **dev** | CloudWatch log-groups only (`/aramo/api/dev`, `/aramo/auth/dev`) | "rarely deployed, minimal." No VPC/RDS/S3/IAM. |
| **staging** | log-groups + `vpc` (10.1.0.0/16) + `rds` (db.t3.small, single-AZ, 7d) + `resume_bucket` + **`iam-app-principal`** | The **only** env wiring the IAM app principal. Has `outputs.tf` (`resume_bucket_name`, `api_principal_user_name`) + a committed `terraform.tfvars`. `.terraform/…tfstate` is committed in tree. |
| **prod** | log-groups + `vpc` (10.0.0.0/16) + `rds` (db.t3.medium, multi-AZ, deletion_protection, 35d) + `resume_bucket` | **Does NOT wire `iam-app-principal`** → prod has no app principal yet. |

**5 modules** (`modules/`): `vpc`, `rds`, `s3-resume-bucket`, `cloudwatch-log-group`, `iam-app-principal`.
**Explicit negatives:** no CDK / CloudFormation / SST / Pulumi / Serverless-framework. Cognito + Redis are **not** in Terraform.

---

## 2. ENV / CONFIG — the full configuration surface

### Config mechanism
- **No `@nestjs/config` / ConfigService.** Every service reads `process.env[...]` directly (the established pattern, stated in `.env.example` header). Validation is **lazy** (stored at construction, throws on first use) — a missing critical var can surface on first request/connect, not at boot.
- **One real `.env` + one `.env.example`, repo-root only.** No per-app `.env`, no `.env.local|.staging`. `.gitignore` ignores `.env*` except `.env.example`.
- **Secrets-store integration is narrow:** only `libs/ai-draft/.../secret-cache.service.ts` uses **AWS Secrets Manager** (id `aramo/${ARAMO_ENV}/anthropic-api-key`). No SSM Parameter Store, no Vault. All other AWS creds use the SDK **default credential chain**.
- **Env-awareness is thin:** `NODE_ENV==='production'` only gates the Secure-cookie flag; `ARAMO_ENV` only routes the Secrets-Manager path. **No dev/staging/prod config-file switching** — env differentiation is entirely "which values land in the single root `.env`."

### Service inventory (correction: 4 apps; only `ats-web` is a frontend)
| App | Type | Default port |
|---|---|---|
| `apps/api` | NestJS backend | `3000` (`PORT`) |
| `apps/auth-service` | NestJS auth/OIDC | `3001` (`PORT`) |
| `apps/platform-admin` | NestJS backend | `3002` (`PORT`) |
| `apps/ats-web` | Vite/React FE | `4201` dev / `4301` preview (hardcoded) |

### Env-var surface — `auth-service`
**THROW-if-unset:** `AUTH_AUDIENCE` (jwt aud), `AUTH_PRIVATE_KEY` (RS256 PKCS#8, signs session tokens), `AUTH_PUBLIC_KEY` (RS256 SPKI, verifies), `AUTH_PKCE_STATE_KEY` (AES-256-GCM key for PKCE state cookie), `AUTH_COGNITO_DOMAIN`, `AUTH_COGNITO_CLIENT_ID`, `AUTH_COGNITO_REDIRECT_URI`, `AUTH_POST_LOGIN_REDIRECT`, **`AUTH_COGNITO_SIGNOUT_REDIRECT`** (D3; open-redirect guard, throws `signout_redirect_missing`).
**Defaulted/optional:** `PORT`(3001), `NODE_ENV`, `AUTH_ALLOW_INSECURE_COOKIES` (only `'true'` allows non-Secure / local http), `AUTH_COGNITO_ISSUER` (falls back to `https://${AUTH_COGNITO_DOMAIN}`; for real AWS pools **must** be `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`), `AUTH_TRUSTED_IDP_NAMES` (default `''` fail-closed; federated IdP names), `AUTH_REFRESH_GRACE_SECONDS` (30).

### Env-var surface — `api` (+ imported libs)
**THROW-if-unset:** `DATABASE_URL` (every `prisma.service.ts`, ~20 schema clients), `AUTH_AUDIENCE`+`AUTH_PUBLIC_KEY` (`jwt-auth.guard.ts`; issuer hardcoded `"Aramo Core Auth"`), `AUTH_COGNITO_TENANT_USER_POOL_ID` (AdminCreate/Delete/Disable/Enable), `S3_RESUME_BUCKET`, `ARAMO_ENV` (Secrets-Manager id), `GOOGLE_PLACES_API_KEY` (only if provider=google & enabled).
**Defaulted/optional:** `PORT`(3000), `AWS_REGION`(`us-east-1`), `S3_ENDPOINT`(null; LocalStack), `AUTH_COGNITO_ENDPOINT`(unset; LocalStack), `REDIS_URL` (lazy; BullMQ fails on use if unset), `ADDRESS_AUTOCOMPLETE_ENABLED|_PROVIDER`, `IMPORT_FAILURE_THRESHOLD_PCT`(10), `IMPORT_REVERT_WINDOW_DAYS`(7), `TALENT_XFACET_GUARD`(5000). `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` — not read in code, consumed by SDK default chain.

### Env-var surface — `platform-admin`
`PORT`(3002), `AWS_REGION`, `AUTH_COGNITO_ENDPOINT`(LocalStack), **`AUTH_COGNITO_PLATFORM_USER_POOL_ID`** (THROW), `AUTH_COGNITO_TENANT_USER_POOL_ID` (THROW; same var `api` reads — pools shared by name across services), plus shared backend vars (`DATABASE_URL`, etc.).

### Env-var surface — `ats-web` (FE)
**Reads NO backend/auth env vars.** Only `import.meta.env.DEV` to gate dev-only routes. Backend URLs are **relative paths** (`ApiClient` base `''`); the Vite dev proxy maps `/v1`→:3000, `/auth`→:3001. **In prod the FE relies on a reverse proxy fronting both backends on one origin** (the FE has zero env knobs). E2E-only (Playwright): `RC_E2E_USERNAME|PASSWORD|TOTP_SECRET|BASE_URL|CHROMIUM`.

### Hardcoded localhost / dev values
**None in shipped app-code.** All localhost/port literals are confined to `apps/ats-web/vite.config.ts` (dev server + proxy, not in prod bundle), `playwright.config.ts`, `*.spec.ts`, and `main.ts` `PORT` defaults. The **D3 redirect/sign-out URLs and Cognito hosted-UI domain are fully env-driven** (all throw if unset).

---

## 3. TENANT RESOLUTION — how the tenant is resolved per request TODAY *(the load-bearing question)*

### VERDICT — definitive
**Tenancy is ALREADY fully JWT-driven.** The per-request tenant is the `tenant_id` claim inside the verified JWT, and nothing else. There is **zero** host/subdomain/origin-based tenant resolution anywhere — backend or FE. **`astre.aramo.ai` would be purely cosmetic/routing; §2-F "subdomain resolution" is a no-op, not a real build.**

### Exact mechanism
- **Set in the JWT auth guard** `libs/auth/src/lib/jwt-auth.guard.ts`: verifies JWS (RS256, issuer `"Aramo Core Auth"`, aud `AUTH_AUDIENCE`, key `AUTH_PUBLIC_KEY`, `:95-100`); token from `Authorization: Bearer` else cookie `aramo_access_token` (`:113-152`, **host never read**); pulls `tenant_id` off the verified payload and requires it (`toAuthContext()`, `:164-185`, missing → `INVALID_TOKEN` 401); attaches `request.authContext = ctx` (`:109`).
- **Shape** (`auth-context.types.ts:32-47`): `{ sub, consumer_type, actor_kind, tenant_id, scopes[], iat, exp, site_id? }`. Handlers read it via the `@AuthContext()` param decorator. No CLS/AsyncLocalStorage for tenant — plain per-request property.
- **DB scoping:** controllers thread `authContext.tenant_id` into every repo call; repos put it in the Prisma `where` (e.g. `talent-record.repository.ts:441,227-231`; `requisition.controller.ts:116,…`). DTOs explicitly forbid tenant in the body (`create-requisition-request.dto.ts:6` "derived from AuthContext.tenant_id, never the body").

### Host / subdomain role TODAY — none
The only `host`/`hostname` matches are **comments** about Cognito hosted-UI redirect URLs (`auth.controller.ts:207,218,376,383`). FE has no `window.location.hostname`/`subdomain`/origin-based lookup; API base is same-origin relative.

### Where the JWT gets its `tenant_id` (issuance linkage)
Set at login from the user's **DB tenant membership**, not from host or a Cognito attribute: `session-orchestrator.service.ts:193` `getTenantsByUser` → 0 → `no_active_tenant`, >1 → `tenant_selection_required` (picker), exactly 1 → stamp `selectedTenant.id` into the signed JWT (`:251-257`; same on refresh). Linkage = **Cognito authenticates the human → identity-DB membership decides the tenant → JWT `tenant_id`.** Platform-tier tokens carry a sentinel `PLATFORM_TENANT_SENTINEL_ID`.

### Caveat for whoever builds subdomains
There is **no** enforcement that the host matches the JWT's tenant — a token for tenant X works on `x.aramo.ai`, `y.aramo.ai`, or bare domain. A "host must agree with token tenant" check would be **net-new** (NOT required for data isolation, which the claim already guarantees).

### Cross-tenant isolation — proven
Structural: every repo `where` keyed on token `tenant_id`; tenant never from body/host. Integration tests against real Postgres assert it — e.g. `ats-batch2-requisition.integration.spec.ts:139-140,696-699` (cross-tenant company probe → empty, no leak; out-of-scope rows → 404 not 403). Many sibling specs (settings-d2/d3, auth-hardening-d4b) assert the same.

---

## 4. MIGRATION APPLY — how Prisma migrations reach a database

### Topology (correction to the prompt's "single multiSchema datasource")
**Schema-per-module**: ~27 module schemas at `libs/*/prisma/schema.prisma`, **each with its own `datasource db` block and its own generated client** (`output = "./generated/client"`). One physical Postgres DB partitioned into ~30 named schemas (identity, company, contact, talent, engagement, submittal, requisition, …). A few datasources span multiple PG schemas (e.g. canonicalization → `canonicalization,talent,talent_evidence,ingestion`). Cross-schema refs are **UUID-only, no FK constraints**. Prisma **7.8** (multiSchema is GA; **no `previewFeatures` flag** anywhere). Runtime uses driver-adapter `@prisma/adapter-pg`.

**65 migration folders** total across 27 libs (`libs/<lib>/prisma/migrations/<timestamp>_<name>/migration.sql`); timestamp prefix = lexical = chronological.

### Curated apply-lists (the test pattern)
Integration tests spin up a Postgres 17 **testcontainer**, then apply migration SQL by hand: `readFileSync(migration.sql)` → split DDL → `prisma.$executeRawUnsafe(stmt)`. **No shared helper**; each spec hardcodes its own list. Two flavors:
- **Curated array** (most specs) — e.g. `libs/identity/src/tests/identity.integration.spec.ts:37-57` lists exactly the 4 identity migrations it needs. The **apps/api cross-schema specs hardcode multi-lib lists** (the "curated apply-list" of memory) — `ats-batch1-gating.integration.spec.ts:52-86` pulls SQL from entitlement+company+contact. **Load-bearing gotcha** (`:87-90`): every spec creating rows in {company, contact, requisition, talent_record} MUST apply the matching `add_import_batch_id_*` migration or the client's RETURNING SELECT 500s (CI-only).
- **Apply-all chronological** — `ingestion.integration.spec.ts:28-44` reads the dir, sorts, applies all; its comment is the only in-repo statement of intent ("mirroring how `prisma migrate deploy` runs in production").

**Why curated, not `migrate deploy`:** Prisma 7 removed `url = env(...)` from datasource blocks, so the CLI targets **one** schema at a time via `prisma.config.ts` — there is no single `migrate deploy` covering all 27 modules. Tests also want only the subset they touch, against history-less ephemeral containers.

### Dev apply path
- **`prisma.config.ts`** (root) — the only CLI config — points at a **single** module (currently `libs/consent`), URL from `DATABASE_URL`. Its own comment flags this as a known limitation. So workspace-level `prisma migrate dev` is effectively unused.
- **The real dev applier is `tools/db-sync-local.sh`** (`package.json` `db:sync:local`): a **bespoke raw-SQL replayer** (not Prisma migrate). Auto-discovers `libs/*/prisma/migrations/*/`, sorts by timestamp, applies each `migration.sql` via `psql --single-transaction`, tracks idempotency in its **own** table `public._local_migrations` (NOT Prisma's `_prisma_migrations`). Modes: `--baseline`, `--status`, default. Seeding via `prisma:seed-identity`. Orchestrated by `tools/local-stack.sh up`.

### Prod apply path — **DOES NOT EXIST**
- **No `prisma migrate deploy` anywhere** — `grep` hits only 2 comments, never executed. CI has no migration step. **No compute platform in IaC** → no migration runner (`grep aws_ecs|aws_lambda|codebuild|aws_instance|fargate` = none).
- **RDS exists** (`modules/rds/main.tf`): Postgres **15.7**, `db.t3.medium` prod / `db.t3.small` staging, multi-AZ prod, `storage_encrypted`, `publicly_accessible=false`, `deletion_protection=true`. **Master password managed by AWS Secrets Manager** (`manage_master_user_password=true`) — no plaintext password, **no `DATABASE_URL` output emitted**.

**Blockers for a safe prod apply (for the migration directive):**
1. **No prod apply mechanism — must be built.** RDS is private (`publicly_accessible=false`, private subnets) → migrator must run **inside the VPC** (bastion / ECS one-shot / Lambda-in-VPC / VPC-attached CI runner). None exists.
2. **No prod `DATABASE_URL`** — must be assembled out-of-band from the RDS endpoint + the Secrets-Manager-managed master secret; something must populate `process.env.DATABASE_URL`.
3. **27 independent schemas, no unified migrate command.** Either loop `prisma migrate deploy` per-schema (config/flag per lib) or reuse `db-sync-local.sh`'s raw-replay against RDS — but the latter tracks history in `_local_migrations`, **not** Prisma's `_prisma_migrations` (a divergence to decide).
4. **No `_prisma_migrations` baseline** anywhere (dev uses `_local_migrations`) — migration-history strategy needs an explicit decision.
5. **Postgres version skew to confirm:** tests use PG17 testcontainers; RDS module is PG **15.7**. Verify migrations are 15-compatible.

---

## 5. MULTI-ENV READINESS — what assumes a single environment

The single root `.env` IS the only per-env config artifact in the repo. Everything below must be supplied per environment (no config-file switching exists). Things to parameterize for staging+prod:

| Concern | Var(s) | Today |
|---|---|---|
| DB connection | `DATABASE_URL` | localhost in `.env.example`; **no prod value produced** (assemble from RDS endpoint + SM secret) |
| Redis | `REDIS_URL` | localhost; **Redis not in IaC** (provision out-of-band) |
| Cognito pools | `AUTH_COGNITO_TENANT_USER_POOL_ID`, `AUTH_COGNITO_PLATFORM_USER_POOL_ID` | **out-of-band, not IaC** |
| Cognito OIDC | `AUTH_COGNITO_DOMAIN`, `AUTH_COGNITO_CLIENT_ID`, `AUTH_COGNITO_ISSUER` (set to real `cognito-idp.<region>…/<poolId>` in prod) | env-driven |
| Callback / post-login | `AUTH_COGNITO_REDIRECT_URI`, `AUTH_POST_LOGIN_REDIRECT` | env-throw; must be registered on the Cognito app client |
| **D3 sign-out** | `AUTH_COGNITO_SIGNOUT_REDIRECT` | env-throw; must exactly match a registered Cognito sign-out URL |
| Crypto | `AUTH_PRIVATE_KEY`, `AUTH_PUBLIC_KEY`, `AUTH_AUDIENCE`, `AUTH_PKCE_STATE_KEY` | env; must be generated per env |
| S3 | `S3_RESUME_BUCKET`, `AWS_REGION` | bucket from TF output `resume_bucket_name` |
| Secrets routing | `ARAMO_ENV` | builds `aramo/${ARAMO_ENV}/anthropic-api-key` |
| Cookie security | `NODE_ENV=production`, drop `AUTH_ALLOW_INSECURE_COOKIES` | dev allows insecure http cookies |
| **D6 MFA target** | (no env var) — Cognito **pool policy** `set-user-pool-mfa-config ON+TOTP` | **out-of-band deploy item**, per-pool, per-account |
| FE origin | (none) | FE needs a **reverse proxy** mapping `/v1`→api, `/auth`→auth-service on one origin |

**Cleanest seam to parameterize:** there is no central config module today (scattered `process.env`). Two viable seams — (a) keep the per-service `.env` contract and inject the full set via the deploy platform's env/secret mechanism (lowest-churn, matches current pattern); (b) introduce a thin per-service config module that reads from Secrets Manager/SSM (more work, but removes plaintext env sprawl and aligns with the one existing SM consumer). Recommend (a) for first prod cut, (b) as a follow-up — don't block go-live on a config refactor.

---

## 6. AWS TOUCHPOINTS — what AWS the app uses, and how it's credentialed

SDK deps: `@aws-sdk/client-cognito-identity-provider`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/client-secrets-manager` (`~3.1053.0`).

**Every SDK client uses the AWS default credential chain — NO hardcoded keys in code.** All clients pass only `region` (+ optional LocalStack `endpoint`), never `credentials`.

| Touchpoint | Where constructed | Config / creds |
|---|---|---|
| **Cognito (tenant)** | `apps/api/src/cognito/tenant-cognito.adapter.ts:37-43` | `AWS_REGION`(`us-east-1`) + opt `AUTH_COGNITO_ENDPOINT`; pool `AUTH_COGNITO_TENANT_USER_POOL_ID` |
| **Cognito (platform)** | `apps/platform-admin/.../cognito-admin.service.ts:38-48` | same; pools `…PLATFORM…` + `…TENANT…` |
| **S3** | `libs/object-storage/.../s3-client.factory.ts:23-31` | `region`, `forcePathStyle`, opt `endpoint`; default chain ("env/shared/instance-profile/IRSA — never hardcoded") |
| **Secrets Manager** | `libs/ai-draft/.../secret-cache.service.ts:45-46` | `region`; `GetSecretValue` for `aramo/${ARAMO_ENV}/anthropic-api-key` (only SM consumer) |

- **Today's principal:** because no compute platform exists, the app authenticates via a **scoped IAM *user*** with out-of-band access keys placed in the secret store and exposed as `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. The `iam-app-principal` module deliberately does **not** create the access key (would leak into TF state). **Only `staging` wires this module — `prod` has no app principal yet.**
- **Cognito is NOT in Terraform** (`grep cognito infrastructure` = empty) — pools, app clients, hosted-UI domain, and the **D6 MFA policy** are all out-of-band.
- **S3:** bucket `S3_RESUME_BUCKET` (e.g. `aramo-staging-resumes`), résumé/attachment storage, presigned PUT/GET capped at 300s (PII floor). IaC: `s3-resume-bucket` module — private, SSE-KMS (dedicated CMK), CORS-scoped, lifecycle-aligned; in staging+prod.
- **RDS:** `DATABASE_URL` (`postgresql://…`), consumed by each `PrismaService` via `process.env['DATABASE_URL']` into `PrismaPg` (lazy-validated at first `$connect`). Master password in Secrets Manager; no DSN output emitted.
- **Region:** single `AWS_REGION` (default `us-east-1`), read independently by every client.

### What changes for a separate Aramo prod account
1. **Recreate all out-of-band AWS by hand in the prod account:** Cognito user pools (tenant + platform) + app clients (public PKCE, no secret) + hosted-UI domain + callback/sign-out URLs + **D6 MFA pool policy** (`set-user-pool-mfa-config ON+TOTP`); Redis/ElastiCache; the Anthropic secret in Secrets Manager.
2. **Wire the prod app principal** — `prod/main.tf` currently has **no** `iam-app-principal`; add it (or, better, migrate to a compute task/instance role / IRSA when the compute platform lands and retire the IAM user).
3. **New `S3_RESUME_BUCKET`, new RDS, new VPC** — TF already differs prod composition; apply in the prod account with prod `terraform.tfvars` and the prod state backend bucket.
4. **Re-point every env var** in §5 to prod values; set `AUTH_COGNITO_ISSUER` to the real `cognito-idp.<region>.amazonaws.com/<poolId>`.
5. **Rotate the developer's local `AKIA…` key** (currently in the gitignored `.env`) — do not carry it forward.

---

## 7. COST-TAGGING / INFRA ISOLATION

### Tagging
Tagging exists but is a **fixed workspace-wide default — NOT cost-allocation / per-tenant.** Every `provider.tf` sets `default_tags { Project="Aramo", Environment=var.environment, ManagedBy="Terraform" }` (documented `doc/adr/0012-iac-conventions.md:155`, "intentionally not configurable per module"). Modules layer `Name`/`Purpose` via `merge(var.tags, …)`. Each `main.tf` has an empty `common_tags = {}` local reserved for future overlays. **No `CostCenter`, no `Tenant`, no cost-allocation tag anywhere.** → cost-tagging is a **tagging layer to add**, not a re-architecture.

### Isolation — confirmed purely logical/pooled
**No infra-per-tenant.** One shared RDS per env (db `aramo`); one shared résumé bucket per env with **tenant_id embedded in the object key path** (`s3-resume-bucket/main.tf:118-120`), not separate buckets; one Cognito pool (no pool-per-tenant). No bucket/pool/DB-per-tenant TF constructs. Logical multi-tenancy is enforced at the **app/data layer** — the JWT `tenant_id` → Prisma `where` invariant (§3), proven cross-tenant-impossible by integration tests. → **cost-tagging is a layer, not a re-architecture** (confirmed).

---

## Appendix — explicit negatives (so the Lead doesn't re-hunt)
- No Dockerfiles (any service). No container registry. No compute deploy target provisioned (ECS/EKS/Fargate/Lambda/App Runner).
- No CloudFormation / CDK / SST / Pulumi / Serverless-framework — Terraform is the sole IaC.
- No deploy/release script; no `terraform apply`/`plan` or image push in CI.
- No `prisma migrate deploy` executed anywhere (comments only); no `_prisma_migrations` baseline; no prod migration runner.
- No subdomain/host→tenant resolution (and no host-vs-token enforcement).
- Cognito + Redis not in Terraform. Prod has no IAM app principal wired.
- No cost-allocation/per-tenant tags; no infra-per-tenant.
