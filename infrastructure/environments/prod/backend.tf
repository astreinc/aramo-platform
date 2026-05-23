terraform {
  backend "s3" {
    bucket         = "aramo-terraform-state-prod"
    key            = "prod/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "aramo-terraform-locks"
    encrypt        = true
  }
}
