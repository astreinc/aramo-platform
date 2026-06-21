# Aramo Terraform Modules

## Data-plane modules (M4 / M5 / A8)

- `cloudwatch-log-group` — per-service CloudWatch log groups.
- `vpc` — VPC + public/DB/private-app subnet tiers + IGW + NAT + route
  tables + RDS SG. (DB tier from M5 PR-10a; public/private-app + IGW/NAT
  added by Step-4 Directive 2.)
- `rds` — RDS Postgres (managed master secret).
- `s3-resume-bucket` — private SSE-KMS résumé bucket + least-privilege
  policy doc.
- `iam-app-principal` — legacy scoped IAM **user** for the résumé bucket
  (superseded by the ECS task role once compute lands; retire follow-up).

## Compute / run-layer modules (Step-4 Directive 2)

- `ecr-repository` — one ECR repo per backend image (scan-on-push +
  keep-last-N lifecycle).
- `secrets-manager` — Secrets Manager **containers** (values out-of-band).
- `app-security-groups` — the least-privilege SG mesh (ALB / service /
  Redis) + the RDS ingress rule.
- `elasticache-redis` — modest single-node Redis for BullMQ.
- `ecs-cluster` — the Fargate cluster.
- `alb` — internet-facing ALB + target groups + HTTP listener + routing.
- `ecs-service` — per-service Fargate task def + service + execution/task
  roles (instantiated twice: api, auth-service).

## Honest boundary

The compute modules are **account-independent authoring** —
`validate`/`fmt`/`tfsec`/`tflint`-clean now; `terraform apply` (the real
proof) is gated on the AWS account being created. The data plane has
never been applied either, so first-apply is the proof for both layers.
Apply incrementally: data plane first, then compute. See
`doc/step4-compute-iac.md`.

See ADR-0012 for conventions.
