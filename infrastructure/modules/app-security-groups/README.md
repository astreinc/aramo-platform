# app-security-groups

Aramo Terraform module (Step-4 Directive 2 — compute IaC). Owns the
least-privilege security-group mesh for the run layer in one place, and
adds the one ingress rule the existing RDS SG was missing.

## The mesh

```
internet ──80/443──▶ alb_sg ──api_port/auth_port──▶ service_sg ──┬─5432─▶ rds_sg (existing)
                                                                  ├─6379─▶ redis_sg
                                                                  └─443──▶ 0.0.0.0/0 (ECR/Secrets/S3/Cognito via NAT)
redis_sg ◀──6379── service_sg only
```

- **No broad ingress to the services or Redis** — only the ALB is
  internet-facing; only it reaches the services; only the services reach
  Redis and RDS.
- The RDS SG ingress rule (service → 5432) lives here, not in the `vpc`
  module, to avoid a vpc↔compute cycle.

## Inputs

| Name                    | Type          | Default | Description                                                       |
| ----------------------- | ------------- | ------- | ----------------------------------------------------------------- |
| `environment`           | `string`      | n/a     | `dev` / `staging` / `prod`.                                       |
| `vpc_id`                | `string`      | n/a     | `module.vpc.vpc_id`.                                              |
| `rds_security_group_id` | `string`      | n/a     | Existing RDS SG (`module.vpc.rds_security_group_id`).             |
| `api_port`              | `number`      | `3000`  | api container port.                                              |
| `auth_port`             | `number`      | `3001`  | auth-service container port.                                     |
| `tags`                  | `map(string)` | `{}`    | Tag overlay layered on provider `default_tags`.                 |

## Outputs

| Name                        | Description                                          |
| --------------------------- | ---------------------------------------------------- |
| `alb_security_group_id`     | Pass to the `alb` module.                            |
| `service_security_group_id` | Pass to both `ecs-service` instances.                |
| `redis_security_group_id`   | Pass to the `elasticache-redis` module.              |
