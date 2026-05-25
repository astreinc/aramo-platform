# Runbook — Bootstrap Anthropic API key in AWS Secrets Manager

Per [ADR-0015](../adr/Aramo-ADR-0015-AI-Substrate-Posture-v1_0-LOCKED.md)
Decision 4 + M5 PR-5 directive §4.7. The `libs/ai-draft` substrate fetches
the Anthropic API key lazily on first use via `SecretCacheService`. The
secret id template is `aramo/${ARAMO_ENV}/anthropic-api-key`.

## Prerequisites

- AWS CLI configured for the target account.
- IAM permissions:
  - `secretsmanager:DescribeSecret` (idempotency check).
  - `secretsmanager:CreateSecret` (bootstrap path).
  - `secretsmanager:GetSecretValue` (verification).
- An Anthropic API key for each environment (obtained from the Anthropic
  console under the Aramo organization).

## Execution — bootstrap per environment

Run the script once per environment. The script is idempotent — re-runs
where the secret already exists report and exit 0.

```bash
./infrastructure/bootstrap/create-anthropic-secret.sh --env dev
./infrastructure/bootstrap/create-anthropic-secret.sh --env staging
./infrastructure/bootstrap/create-anthropic-secret.sh --env prod
```

The script prompts for the API key on stdin (hidden) unless `--api-key`
is passed. CI/CD pipelines should pass the key via `--api-key` from a
preceding secret-fetch step rather than via stdin.

`AWS_REGION` env controls region; default is `us-east-1`.

## Verification

```bash
aws secretsmanager get-secret-value \
  --secret-id aramo/dev/anthropic-api-key \
  --region us-east-1 \
  --query SecretString --output text | head -c 12
```

A successful fetch prints the first 12 characters of the key
(`sk-ant-api03` for an Anthropic admin-issued key).

## Rotation procedure (manual, PR-5)

PR-5 ships manual rotation only. To rotate:

1. Obtain a new key from the Anthropic console.
2. `aws secretsmanager put-secret-value --secret-id <id> --secret-string <new-key>`.
3. Restart the consuming process(es) to flush in-memory SecretCacheService.
4. Revoke the previous key in the Anthropic console.

Automated rotation lands at M7 IaC alongside KMS key rotation policy.

## Failure-mode catalog

| Symptom | Likely cause | Remediation |
|---|---|---|
| `ARAMO_ENV not set` AramoError | App started without ARAMO_ENV in env | Set ARAMO_ENV=dev/staging/prod and restart |
| `secret missing: aramo/<env>/anthropic-api-key` | Bootstrap not yet run for this env | Run the script for the missing env |
| `secret_decryption_failed` | KMS access denied (key policy / IAM role) | Verify the runtime IAM role has `kms:Decrypt` on the secret's encryption key |
| `aws_internal_error` (HTTP 502 to caller) | AWS Secrets Manager outage | Status page; retry after recovery |
| `secret_request_invalid` | Secret id formatting issue (env override) | Verify ARAMO_ENV is one of dev/staging/prod |
