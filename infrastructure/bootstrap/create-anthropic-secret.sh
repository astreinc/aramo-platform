#!/usr/bin/env bash
# M5 PR-5 — Bootstrap script for the Anthropic API key Secrets Manager
# entry. Per ADR-0015 Decision 4: secrets live in AWS Secrets Manager.
# Idempotent — re-runs are no-ops if the secret already exists.
#
# Usage:
#   ./infrastructure/bootstrap/create-anthropic-secret.sh --env dev
#   ./infrastructure/bootstrap/create-anthropic-secret.sh --env dev --api-key sk-ant-...
#
# Region: AWS_REGION env or us-east-1 default.
# Rotation: manual at PR-5 — re-run with --api-key to overwrite. M7 IaC
# adds automated rotation.

set -euo pipefail

env_name=""
api_key=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      if [[ $# -lt 2 ]]; then
        echo "Error: --env requires a value" >&2
        exit 2
      fi
      env_name="$2"
      shift 2
      ;;
    --api-key)
      if [[ $# -lt 2 ]]; then
        echo "Error: --api-key requires a value" >&2
        exit 2
      fi
      api_key="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 --env <dev|staging|prod> [--api-key <value>]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$env_name" ]]; then
  echo "Error: --env is required (dev|staging|prod)" >&2
  exit 2
fi

case "$env_name" in
  dev|staging|prod) ;;
  *)
    echo "Error: --env must be one of dev|staging|prod (got: $env_name)" >&2
    exit 2
    ;;
esac

region="${AWS_REGION:-us-east-1}"
secret_id="aramo/${env_name}/anthropic-api-key"

if aws secretsmanager describe-secret --secret-id "$secret_id" --region "$region" >/dev/null 2>&1; then
  echo "secret already present: $secret_id (region=$region) — no-op"
  exit 0
fi

if [[ -z "$api_key" ]]; then
  read -r -s -p "Anthropic API key for $secret_id: " api_key
  echo
fi

if [[ -z "$api_key" ]]; then
  echo "Error: API key cannot be empty" >&2
  exit 1
fi

aws secretsmanager create-secret \
  --name "$secret_id" \
  --description "Anthropic API key for Aramo ai-draft substrate (M5 PR-5 / ADR-0015)" \
  --secret-string "$api_key" \
  --region "$region" >/dev/null

echo "secret created: $secret_id (region=$region)"
