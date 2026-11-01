# Aramo production monitoring (Sign launch operations, PO 2026-11-01) — its OWN Terraform
# root and state key, like infrastructure-backups/. Same state bucket and lock table as
# infrastructure-lightsail/, separate key, so an apply here can only change the
# monitoring resources below.
#
# Apply from the operator Mac ONLY (the box is in the wrong AWS account and gets a 403 on
# the state bucket). Procedure: doc/runbooks/sign/monitoring-and-alerts.md §2.
terraform {
  backend "s3" {
    bucket         = "aramo-terraform-state-prod"
    key            = "monitoring/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "aramo-terraform-locks"
    encrypt        = true
  }
}
