# elasticache-redis

Aramo Terraform module (Step-4 Directive 2 — compute IaC). A modest
single-node Redis (ElastiCache replication group) in the VPC's
private-app subnets, for BullMQ.

The recon found no Redis modeled; BullMQ degrades gracefully without it
only locally — prod needs a real Redis. Reachable **only** from the
services' security group (no public access).

## Posture

- Single node (`num_cache_clusters = 1`, automatic failover off) on a
  small node type — modest first deploy. Multi-AZ + replica is the
  scale-later flip.
- At-rest encryption **on**. Transit encryption **off** for the first
  deploy (enabling it forces `rediss://` + an auth token, which the
  app's plain `REDIS_URL` does not yet carry) — a coordinated hardening
  follow-up.

## Inputs

| Name                       | Type           | Default                   | Description                                                        |
| -------------------------- | -------------- | ------------------------- | ------------------------------------------------------------------ |
| `environment`              | `string`       | n/a                       | `dev` / `staging` / `prod`.                                        |
| `subnet_ids`               | `list(string)` | n/a                       | Private-app subnet IDs (`module.vpc.private_app_subnet_ids`).      |
| `security_group_ids`       | `list(string)` | n/a                       | Redis SG (ingress from services' SG on 6379 only).                |
| `node_type`                | `string`       | `"cache.t4g.micro"`       | Node type (modest default).                                       |
| `engine_version`           | `string`       | `"7.1"`                   | Redis engine version.                                            |
| `maintenance_window`       | `string`       | `"sun:04:00-sun:05:00"`   | Weekly UTC maintenance window.                                   |
| `snapshot_retention_limit` | `number`       | `1`                       | Days of automatic snapshots (0 = disabled).                     |
| `tags`                     | `map(string)`  | `{}`                      | Tag overlay layered on provider `default_tags`.                 |

## Outputs

| Name                       | Description                                                       |
| -------------------------- | ---------------------------------------------------------------- |
| `primary_endpoint_address` | Primary endpoint host.                                           |
| `port`                     | Redis port (6379).                                               |
| `redis_url`                | Assembled `redis://host:port` for the app `REDIS_URL` env.       |
