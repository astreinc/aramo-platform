# ecr-repository

Aramo Terraform module (Step-4 Directive 2 — compute IaC). One ECR
repository per backend container image. Instantiated once per image
(api, auth-service), mirroring the `cloudwatch-log-group` per-instance
precedent.

## Purpose

Holds the production images the D1 Dockerfiles build
(`apps/api/Dockerfile`, `apps/auth-service/Dockerfile`). The ECS task
definitions reference `${repository_url}:<tag>` for the container image.

- `scan_on_push = true` — CVE scan on every push.
- Keep-last-N lifecycle policy — caps registry growth (untagged pruned
  first, then images beyond `image_retention_count`).
- AES256 encryption at rest (account-default; a dedicated CMK is the
  hardening option).

## Inputs

| Name                             | Type          | Default     | Description                                                        |
| -------------------------------- | ------------- | ----------- | ------------------------------------------------------------------ |
| `name`                           | `string`      | n/a         | Repository name (e.g. `aramo-prod-api`).                           |
| `image_tag_mutability`           | `string`      | `"MUTABLE"` | `MUTABLE` (rolling `:latest`) or `IMMUTABLE` (per-digest; harden). |
| `image_retention_count`          | `number`      | `10`        | Keep at most this many images.                                     |
| `untagged_image_retention_count` | `number`      | `2`         | Keep at most this many untagged images.                            |
| `force_delete`                   | `bool`        | `false`     | Allow destroy of a non-empty repo (keep false in prod).            |
| `tags`                           | `map(string)` | `{}`        | Tag overlay layered on provider `default_tags`.                    |

## Outputs

| Name              | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| `repository_url`  | Repository URI; image ref is `${repository_url}:<tag>`.      |
| `repository_arn`  | Repository ARN.                                              |
| `repository_name` | Repository name.                                             |

## Usage

```hcl
module "ecr_api" {
  source = "../../modules/ecr-repository"
  name   = "aramo-${var.environment}-api"
  tags   = local.common_tags
}
```

## Pushing an image (when the account exists)

```sh
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker build -f apps/api/Dockerfile -t <repository_url>:<tag> .
docker push <repository_url>:<tag>
```
