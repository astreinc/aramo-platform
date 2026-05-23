# Aramo Terraform Bootstrap (RUN-ONCE)

This directory contains one-time AWS resource provisioning that MUST
happen BEFORE any `terraform init` runs in `infrastructure/environments/`.

## What it does

Creates the S3 buckets + DynamoDB lock table that Terraform's S3 backend
uses for state storage and concurrent-modification locking. These resources
are NOT Terraform-managed (chicken-and-egg).

## When to run

ONLY ONCE per AWS account. After this script runs successfully, all
subsequent state changes (including creating these same resources in
other accounts) are managed by Terraform itself.

## How to run

```bash
cd infrastructure/bootstrap
AWS_PROFILE=<your-aws-profile> AWS_REGION=us-east-1 ./bootstrap.sh
```

Requires AWS CLI configured with permissions to create S3 buckets and
DynamoDB tables.

## After running

You can now `cd ../environments/dev && terraform init` (or staging, prod)
and Terraform will use the bootstrap-provisioned backend.

## Idempotency

This script is NOT idempotent. Re-running will fail with "BucketAlreadyOwned"
errors. If you need to recreate state buckets (highly unusual), delete the
existing resources first.
