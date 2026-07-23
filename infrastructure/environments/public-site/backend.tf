terraform {
  backend "s3" {
    bucket         = "aramo-terraform-state-prod"
    key            = "public-site/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "aramo-terraform-locks"
    encrypt        = true
  }
}
