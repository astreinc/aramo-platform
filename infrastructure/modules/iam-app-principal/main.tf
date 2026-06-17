# -----------------------------------------------------------------------------
# iam-app-principal — the app principal binding for the résumé bucket.
#
# The s3-resume-bucket module EMITS a least-privilege policy document
# (`app_iam_policy_json`: PutObject / GetObject / PutObjectTagging on the
# bucket + KMS GenerateDataKey / Decrypt for SSE-KMS). This module is the
# binding the readiness track owed: it attaches that policy to a principal
# the running API authenticates as.
#
# WHY AN IAM USER (not an assumed role): there is no compute platform in IaC
# yet (no ECS task role, no EKS/IRSA, no instance profile) for a role to be
# assumed by. The API authenticates to AWS today via credentials in its
# environment/secret store. So the interim least-privilege principal is a
# scoped IAM user. When a compute platform lands, MIGRATE to an instance/task
# role (assumed-role / IRSA) attaching this same policy and retire the user.
#
# SECRETS: this module creates the user + the inline scoped policy ONLY. It
# does NOT create access keys — generating them here would write the secret
# into Terraform state. Generate the access key out-of-band and store it in
# the secret store (never committed):
#   aws iam create-access-key --user-name <user_name>
# then wire AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY into the app's secret
# store and S3_RESUME_BUCKET to the bucket name.
# -----------------------------------------------------------------------------

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

resource "aws_iam_user" "this" {
  name = var.name
  path = "/aramo/app/"

  tags = merge(var.tags, {
    Name    = var.name
    Purpose = "resume-bucket-app-principal"
  })
}

# The scoped résumé-bucket policy, attached inline (1:1 with this user — the
# policy is meaningless without the user, so inline keeps them lifecycle-
# bound). The JSON is the s3-resume-bucket module's least-privilege contract
# (bucket + KMS ARNs already resolved inside it).
resource "aws_iam_user_policy" "resume_bucket_access" {
  name   = "${var.name}-resume-bucket-access"
  user   = aws_iam_user.this.name
  policy = var.resume_bucket_policy_json
}
