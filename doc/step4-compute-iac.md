# Step 4 (PROD-Deploy) — Compute IaC (the run layer in the cloud)

**Version 1.0** · Baseline: `16f97de` (D1 merge) · Step-4 Directive 2.
Account-independent authoring; `validate`-clean now, apply gated on the
account.

This is the deploy-side companion to the D1 containerization
(`doc/runbooks/run-layer.md`) and the substrate recon
(`doc/step4-deploy-substrate-recon.md`). It extends the existing
data-plane Terraform with the compute + supporting infra needed to run
the two D1 backend images.

---

## What landed (extends, does not rebuild)

| Concern | Module | Notes |
|---|---|---|
| Container registry | `ecr-repository` ×2 | api + auth-service; scan-on-push + keep-last-N lifecycle. |
| Networking (extended) | `vpc` | Added public + private-app subnet tiers + IGW + single NAT + route tables. DB tier + RDS SG unchanged. |
| Backend run layer | `ecs-cluster` + `ecs-service` ×2 | Fargate cluster + per-service task def + service in **private** subnets. D1 TCP probe = container healthCheck. |
| Load balancing | `alb` | Internet-facing ALB (public subnets) → api (default) / auth-service (`/auth/*`, `/.well-known/*`). HTTP listener (HTTPS = edge directive). |
| Security groups | `app-security-groups` | Least-privilege mesh: ALB→services→RDS/Redis; no broad ingress to services; + the RDS ingress rule the vpc module left open. |
| Queue backend | `elasticache-redis` | Modest single-node Redis for BullMQ (recon found none). |
| Secret store | `secrets-manager` | Secret **containers** (values out-of-band); task defs reference by ARN. |
| Prod app principal | `ecs-service` task roles | Closes the recon gap (prod had no IAM principal) with the compute-native task role. |

Wired across **staging + prod** (dev is data-plane-and-compute-free by
design — see `infrastructure/README.md`).

---

## The honest boundary (the load-bearing point)

- **Now (account-independent, done):** `terraform fmt`, `terraform
  validate` (dev/staging/prod), `tfsec --minimum-severity=HIGH`, and
  `tflint --recursive` are all clean. Module structure mirrors the
  existing data-plane modules.
- **Deferred to account-creation (the real proof):** `terraform apply`
  provisions; the services boot on Fargate; the ALB reaches them;
  healthchecks pass; services reach RDS + Redis + Secrets. **Gated on the
  AWS account** — not faked, exactly like the §5 staging checklist. The
  data-plane Terraform has *never been applied* either, so first-apply is
  the real proof for **both** layers.

### Apply strategy (for when the account exists)

Apply **incrementally**, not all-at-once, to localize first-apply errors:

1. **Data plane first** — vpc (incl. the new subnet tiers/NAT) + rds + s3
   + log groups. Prove the never-applied base.
2. **Compute on top** — ecr → secrets → SG mesh → redis → cluster → alb →
   services.
3. **Push images** — build + push the D1 images to ECR (`ecr-repository`
   README has the commands), then the services pull `:<tag>`.
4. **Populate secrets out-of-band** — `aws secretsmanager put-secret-value`
   for each container (DB URL, auth keys, PKCE key, Google Places,
   Anthropic). See below.
5. **Set `*_extra_env`** — the Cognito URLs / audience / redirect values
   in `terraform.tfvars` (account/DNS-dependent).

---

## Config vs. secrets — the split

The D1 images are env-driven. This directive splits their env contract:

**Plaintext config** (task-def `environment`, from `*_extra_env` + Terraform
outputs): `PORT`, `NODE_ENV`, `ARAMO_ENV`, `AWS_REGION`, `REDIS_URL` (from
the redis module), `S3_RESUME_BUCKET` (from the bucket module), `AUTH_AUDIENCE`,
the `AUTH_COGNITO_*` URLs/IDs (PKCE public client — no client secret),
`AUTH_TRUSTED_IDP_NAMES`, `ADDRESS_AUTOCOMPLETE_*`, `IMPORT_FAILURE_THRESHOLD_PCT`.

**Secret material** (Secrets Manager containers, values out-of-band):

| Secret (`aramo/<env>/…`) | Consumed how |
|---|---|
| `database-url` | execution-role-injected env (api + auth) |
| `auth-public-key` | execution-role-injected env (api + auth) |
| `auth-private-key` | execution-role-injected env (auth) |
| `auth-pkce-state-key` | execution-role-injected env (auth) |
| `google-places-api-key` | execution-role-injected env (api) |
| `anthropic-api-key` | **task-role** `GetSecretValue` — the app's ai-draft lib reads it via the SDK at runtime (not env-injected) |

No secret value is ever written to an image or to Terraform state (the
module creates containers only, never `secret_version`).

**AWS credentials:** Fargate tasks get AWS perms from the **task role** —
no `AWS_ACCESS_KEY_ID`/`SECRET` env. This is the migration the
`iam-app-principal` README anticipated; the api task role carries the
résumé-bucket least-privilege policy directly.

---

## Seams handed to later directives

- **Edge directive (next):** ACM cert + HTTPS :443 listener + Route 53 /
  CloudFront + `ats-web` S3+CloudFront SPA. The ALB SG already permits
  443; `alb_dns_name` / `alb_zone_id` outputs are the handoff.
- **Migration applier (later):** the VPC-internal Prisma applier (RDS is
  `publicly_accessible=false`) — the 27-datasource path from the recon
  §4. The private-app subnets + service SG + `database-url` secret are
  the substrate it will reuse.
- **Hardening follow-ups:** ECR `IMMUTABLE` tags; Redis transit
  encryption (`rediss://` + auth token); per-AZ NAT; retire the legacy
  staging `iam-app-principal` IAM user (superseded by the task role);
  Stripe secret (billing directive).

---

## Reviewed first-deploy exceptions (tfsec)

Four intentional postures carry inline `#tfsec:ignore` with justification
(all directive-sanctioned or structurally required):

- `aws-elb-http-not-used` — HTTP :80 listener (HTTPS = edge directive).
- `aws-elb-alb-not-public` — the ALB is the intended public entry point.
- `aws-ec2-no-public-ip-subnet` — public subnets host only the ALB + NAT.
- `aws-elasticache-enable-in-transit-encryption` — TLS off first deploy
  (plain `REDIS_URL`); at-rest encryption is on.
- `aws-ecr-enforce-immutable-repository` — MUTABLE default for the
  rolling-tag first deploy (IMMUTABLE exposed as a var).

---

## Constraints honored

Terraform only — no app-code change, no new scope, no migration. Secret
**values** out-of-band. Cognito pools/clients remain out-of-band (recon
§6 — recreate by hand in the prod account). Normal merge (structural
review; unappliable until the account exists). No HALT conditions hit:
the modules extended cleanly, no compute choice forced an app-code change
(D1 proved the apps containerize as-is), and the data-plane modules had
no assumption that blocked compute.
