# ecs-cluster

Aramo Terraform module (Step-4 Directive 2 — compute IaC). A single
Fargate ECS cluster per environment for the api + auth-service services.

- Container Insights on (first-deploy observability).
- `FARGATE` + `FARGATE_SPOT` capacity providers; services default to
  on-demand `FARGATE` (SPOT available for later cost tuning).

## Inputs

| Name                 | Type          | Default | Description                            |
| -------------------- | ------------- | ------- | -------------------------------------- |
| `environment`        | `string`      | n/a     | `dev` / `staging` / `prod`.            |
| `container_insights` | `bool`        | `true`  | Enable CloudWatch Container Insights.  |
| `tags`               | `map(string)` | `{}`    | Tag overlay on provider `default_tags`.|

## Outputs

| Name           | Description                              |
| -------------- | ---------------------------------------- |
| `cluster_id`   | Cluster id (pass to `ecs-service`).      |
| `cluster_arn`  | Cluster ARN.                             |
| `cluster_name` | Cluster name.                            |
