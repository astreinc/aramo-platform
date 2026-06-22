# SEPARATE STATE — the load-bearing constraint (Directive §B).
#
# This root reuses the platform's state BUCKET and lock table (they already
# exist) but writes to its OWN key — lightsail/terraform.tfstate — which is a
# different state file from the platform's prod/terraform.tfstate. Separate
# state files = separate `apply` blast radii: applying this root can never
# touch the platform's resources, and vice-versa.
#
# It NEVER shares the platform's state file/key. If the PO prefers full
# isolation, point `bucket` at a dedicated bucket instead — the only hard rule
# is that the key is not prod/terraform.tfstate.
terraform {
  backend "s3" {
    bucket         = "aramo-terraform-state-prod"
    key            = "lightsail/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "aramo-terraform-locks"
    encrypt        = true
  }
}
