# M-A8 §1.1.1 — the backup infrastructure has its OWN Terraform root and state key.
#
# Same state bucket and lock table as infrastructure-lightsail/ (they exist), but a
# separate key, so an apply of this root can only ever change the backup resources
# below. No `-target` is needed and none is allowed for this root.
#
# Apply from the operator Mac ONLY (the box is in the wrong AWS account and gets a
# 403 on the state bucket). Procedure: doc/runbooks/RUNBOOK-backups.md.
terraform {
  backend "s3" {
    bucket         = "aramo-terraform-state-prod"
    key            = "backups/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "aramo-terraform-locks"
    encrypt        = true
  }
}
