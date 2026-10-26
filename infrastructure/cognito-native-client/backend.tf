# SEPARATE STATE. This root reuses the platform's prod state BUCKET and lock table,
# which already exist, but writes to its OWN key, cognito-native-client/terraform.tfstate.
# That state file holds only the aramo-sign-native app client, so applying or
# destroying this root can never touch the user pool, its identity providers, its
# Lambda triggers, the browser client `aramo`, or anything in another root's state.
terraform {
  backend "s3" {
    bucket         = "aramo-terraform-state-prod"
    key            = "cognito-native-client/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "aramo-terraform-locks"
    encrypt        = true
  }
}
