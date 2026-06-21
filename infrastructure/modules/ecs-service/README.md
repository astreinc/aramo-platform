# ecs-service

Aramo Terraform module (Step-4 Directive 2 — compute IaC). The Fargate
run layer for **one** backend image. Instantiated twice (api,
auth-service).

Bundles, per service: the task **execution** role, the task **role**, the
Fargate **task definition** (env-driven, no baked secrets), and the ECS
**service** in the private-app subnets behind the ALB target group.

## The two IAM principals (directive §G)

- **Execution role** — what ECS needs to *start* the task: ECR pull +
  CloudWatch logs (AWS managed `AmazonECSTaskExecutionRolePolicy`) +
  `GetSecretValue` on exactly the secrets this task injects.
- **Task role** — what the *app code* may do against AWS at runtime: an
  optional inline policy (e.g. the résumé-bucket least-privilege JSON) +
  `GetSecretValue` on any SDK-read secrets (e.g. the Anthropic key).

This task role is the compute-native principal the `iam-app-principal`
module README anticipated — the api task role carries the résumé-bucket
policy directly, so prod needs **no IAM user** (closing the recon's
staging/prod gap with the *better* principal).

## Config vs. secrets

- `environment_variables` → the container's `environment` (plaintext,
  non-secret).
- `secrets` (ENV → ARN) → the container's `secrets` block; the execution
  role reads them at task start. Values never enter the image or state.
- `task_role_secret_arns` → SDK-read secrets (the app fetches them itself
  with `GetSecretValue`).

## Health check

The container `healthCheck` is the D1 TCP-connect probe verbatim (zero
app-code). The ALB target-group health check is configured separately in
the `alb` module.

## Key inputs

| Name                           | Type           | Default     | Description                                          |
| ------------------------------ | -------------- | ----------- | ---------------------------------------------------- |
| `name`                         | `string`       | n/a         | Resource name / task family (e.g. `aramo-prod-api`). |
| `service_name`                 | `string`       | n/a         | Container name + log stream prefix (`api`).          |
| `cluster_id`                   | `string`       | n/a         | `module.ecs_cluster.cluster_id`.                     |
| `image`                        | `string`       | n/a         | `<ecr_url>:<tag>`.                                   |
| `container_port`               | `number`       | n/a         | 3000 / 3001.                                         |
| `cpu` / `memory`               | `number`       | `512`/`1024`| Fargate sizing (valid pair).                         |
| `cpu_architecture`             | `string`       | `"X86_64"`  | Must match the pushed image arch.                    |
| `desired_count`                | `number`       | `1`         | Replicas.                                            |
| `subnet_ids`                   | `list(string)` | n/a         | Private-app subnets.                                 |
| `security_group_ids`           | `list(string)` | n/a         | Shared service SG.                                   |
| `target_group_arn`             | `string`       | n/a         | ALB target group.                                    |
| `aws_region`                   | `string`       | n/a         | For awslogs.                                          |
| `log_group_name`               | `string`       | n/a         | Existing `/aramo/<svc>/<env>`.                       |
| `environment_variables`        | `map(string)`  | `{}`        | Plaintext env.                                       |
| `secrets`                      | `map(string)`  | `{}`        | ENV → secret ARN.                                    |
| `task_role_inline_policy_json` | `string`       | `null`      | App runtime policy (e.g. résumé bucket).             |
| `task_role_secret_arns`        | `list(string)` | `[]`        | SDK-read secret ARNs.                                |

## Ordering note

The ECS service's `load_balancer` block requires its target group to be
attached to a listener first. Set `depends_on = [module.alb]` on the
module call in the composition so Terraform orders the listener before
the service.

## Outputs

| Name                  | Description                          |
| --------------------- | ------------------------------------ |
| `service_name`        | ECS service name.                    |
| `task_definition_arn` | Task definition ARN.                 |
| `execution_role_arn`  | Execution role ARN.                  |
| `task_role_arn`       | Task role ARN.                       |
