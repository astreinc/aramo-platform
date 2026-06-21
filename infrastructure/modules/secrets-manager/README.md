# secrets-manager

Aramo Terraform module (Step-4 Directive 2 — compute IaC). Defines the
AWS Secrets Manager **containers** the Fargate tasks consume, on the
established `aramo/<env>/<name>` path convention.

## The honest boundary — values are out-of-band

This module creates `aws_secretsmanager_secret` resources **only**. It
creates **no** `aws_secretsmanager_secret_version`, so **no secret value
is ever written into Terraform state**. The PO populates each value at
account setup:

```sh
aws secretsmanager put-secret-value \
  --secret-id aramo/<env>/database-url --secret-string '<value>'
```

The ECS task definitions reference these by ARN — either execution-role
injection (the task-def `secrets` block) or task-role `GetSecretValue`
(SDK-read secrets such as the Anthropic key). Never baked into an image
or into state.

## Inputs

| Name                      | Type          | Default | Description                                                                 |
| ------------------------- | ------------- | ------- | --------------------------------------------------------------------------- |
| `environment`             | `string`      | n/a     | `dev` / `staging` / `prod`; secret path is `aramo/<env>/<name>`.            |
| `secret_names`            | `map(string)` | n/a     | Logical name → description; one container created per entry.                 |
| `recovery_window_in_days` | `number`      | `7`     | Soft-delete recovery window (0 = immediate; AWS allows 0 or 7–30).          |
| `tags`                    | `map(string)` | `{}`    | Tag overlay layered on provider `default_tags`.                             |

## Outputs

| Name               | Description                                                |
| ------------------ | ---------------------------------------------------------- |
| `secret_arns`      | Map logical name → ARN (wire into task definitions).       |
| `secret_full_names`| Map logical name → full `aramo/<env>/<name>`.              |
| `all_secret_arns`  | Flat list of every ARN (convenience for IAM scoping).      |

## Legacy bootstrap reconciliation

`infrastructure/bootstrap/create-anthropic-secret.sh` creates
`aramo/<env>/anthropic-api-key` out of band. For a **greenfield** account
where this module manages that container, Terraform owns it — do **not**
also run the bootstrap script there (name collision). The script remains
the path for envs not yet under Terraform secret management.
