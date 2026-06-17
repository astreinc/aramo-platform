# Module: iam-app-principal

The app-principal binding for the résumé bucket — the IAM piece the readiness
track owed. The `s3-resume-bucket` module emits a least-privilege policy
document (`app_iam_policy_json`); this module attaches it to the principal the
API authenticates as.

## What it creates
- `aws_iam_user` (path `/aramo/app/`) — the app principal.
- `aws_iam_user_policy` — the résumé-bucket least-privilege policy, **inline**
  (lifecycle-bound to the user). Grants exactly:
  - `s3:PutObject` / `s3:GetObject` / `s3:PutObjectTagging` on the bucket only
  - `kms:GenerateDataKey` / `kms:Decrypt` on the bucket's CMK only

  No `ListBucket`, no `DeleteObject` (RTBF deletion is an operator action with
  elevated creds — see `doc/runbooks/talent-rtbf-erasure.md`), no wildcard, no
  other-bucket access.

## Why an IAM user (and the migration path)
There is no compute platform in IaC yet (no ECS task role, no EKS/IRSA, no
instance profile) for a role to be assumed by. The API authenticates via
credentials in its secret store. So the interim least-privilege principal is a
scoped IAM **user**. **When a compute platform lands, migrate to an
instance/task role (assumed-role / IRSA)** attaching this same policy, and
retire the user. Long-lived keys are the unavoidable interim and live in the
secret store, never committed.

## Credentials (out-of-band — never in Terraform)
This module creates the user + policy ONLY. Generating an access key here would
write the secret into Terraform state. Instead:

```sh
aws iam create-access-key --user-name "$(terraform output -raw api_principal_user_name)"
```

Store the returned `AccessKeyId` / `SecretAccessKey` in the secret store and
wire the app's runtime config:

```
S3_RESUME_BUCKET      = <terraform output resume_bucket_name>
AWS_REGION            = us-east-1
AWS_ACCESS_KEY_ID     = <from secret store>
AWS_SECRET_ACCESS_KEY = <from secret store>
S3_ENDPOINT           = (unset — real AWS)
```

Rotate keys on the normal cadence; rotation does not require a Terraform apply.

## Inputs
| name | description |
|------|-------------|
| `name` | IAM user name (e.g. `aramo-staging-api`) |
| `resume_bucket_policy_json` | `app_iam_policy_json` from the s3-resume-bucket module |
| `tags` | extra tags (provider default_tags already apply Project/Environment/ManagedBy) |

## Outputs
| name | description |
|------|-------------|
| `user_name` | IAM user name (feed to `aws iam create-access-key`) |
| `user_arn` | IAM user ARN |
