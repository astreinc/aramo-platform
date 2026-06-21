# alb

Aramo Terraform module (Step-4 Directive 2 — compute IaC). One
internet-facing Application Load Balancer fronting the two backend
services, with `ip`-target groups (Fargate awsvpc) and path-based
routing.

## Routing

| Path pattern                | Target          |
| --------------------------- | --------------- |
| `/auth`, `/auth/*`, `/.well-known/*` | auth-service (rule, priority 10) |
| everything else (default)   | api             |

## Seams

- **HTTPS**: only an HTTP :80 listener here (fine for first-apply
  validation). ACM cert + :443 listener + DNS are the **edge directive**;
  the ALB SG already permits 443, so adding the HTTPS listener later is
  non-structural.
- **Health checks**: the apps ship no `/health` route. The api check hits
  `/` with matcher `200-499` (any HTTP response = serving, the L7
  analogue of D1's TCP probe); auth hits `/.well-known/jwks.json` with
  matcher `200` (a real readiness signal). Both overridable. The D1 TCP
  container healthCheck is wired separately in the `ecs-service` task def.

## Inputs

| Name                        | Type           | Default                       | Description                                  |
| --------------------------- | -------------- | ----------------------------- | -------------------------------------------- |
| `environment`               | `string`       | n/a                           | `dev` / `staging` / `prod`.                  |
| `vpc_id`                    | `string`       | n/a                           | `module.vpc.vpc_id`.                         |
| `public_subnet_ids`         | `list(string)` | n/a                           | `module.vpc.public_subnet_ids`.              |
| `alb_security_group_id`     | `string`       | n/a                           | ALB SG.                                      |
| `api_port` / `auth_port`    | `number`       | `3000` / `3001`               | Container ports.                             |
| `api_health_check_path`     | `string`       | `"/"`                         | api health path.                             |
| `api_health_check_matcher`  | `string`       | `"200-499"`                   | api matcher.                                 |
| `auth_health_check_path`    | `string`       | `"/.well-known/jwks.json"`    | auth health path.                            |
| `auth_health_check_matcher` | `string`       | `"200"`                       | auth matcher.                                |
| `tags`                      | `map(string)`  | `{}`                          | Tag overlay.                                 |

## Outputs

| Name                    | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `alb_dns_name`          | Public DNS name (first-deploy entry point).          |
| `alb_arn`               | ALB ARN.                                             |
| `alb_zone_id`           | Canonical hosted-zone id (edge directive's alias).   |
| `http_listener_arn`     | HTTP :80 listener ARN.                               |
| `api_target_group_arn`  | Pass to the api `ecs-service`.                       |
| `auth_target_group_arn` | Pass to the auth `ecs-service`.                      |
