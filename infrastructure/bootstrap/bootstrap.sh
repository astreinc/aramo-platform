#!/usr/bin/env bash
# Aramo M4 PR-8 — Terraform backend bootstrap (run-once).
# Creates S3 buckets + DynamoDB lock table BEFORE first `terraform init`.
# After this script runs, all subsequent state changes are Terraform-managed.

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
LOCK_TABLE="aramo-terraform-locks"
ENVIRONMENTS=("dev" "staging" "prod")

# Create DynamoDB lock table (shared across all environments).
aws dynamodb create-table \
  --table-name "${LOCK_TABLE}" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region "${AWS_REGION}"

# Create per-environment S3 state buckets.
for env in "${ENVIRONMENTS[@]}"; do
  BUCKET="aramo-terraform-state-${env}"

  aws s3api create-bucket \
    --bucket "${BUCKET}" \
    --region "${AWS_REGION}"

  aws s3api put-bucket-versioning \
    --bucket "${BUCKET}" \
    --versioning-configuration Status=Enabled

  aws s3api put-bucket-encryption \
    --bucket "${BUCKET}" \
    --server-side-encryption-configuration '{
      "Rules": [{
        "ApplyServerSideEncryptionByDefault": {
          "SSEAlgorithm": "AES256"
        }
      }]
    }'

  aws s3api put-public-access-block \
    --bucket "${BUCKET}" \
    --public-access-block-configuration \
      "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
done

echo "Bootstrap complete. You may now run \`terraform init\` in any environment directory."
