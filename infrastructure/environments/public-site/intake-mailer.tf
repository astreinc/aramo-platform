# Aramo PUB-5 PR-5b (R-PUB5-3) — the narrow SES-send credential for the intake
# handler (apps/public-intake). Terraform owns the IAM user + a least-privilege
# policy (ses:SendEmail / ses:SendRawEmail on the aramo.ai SES identity ONLY).
#
# The PO creates the access key MANUALLY (aws iam create-access-key --user-name
# aramo-public-intake-mailer) and places it in the host .env — so the secret
# NEVER enters Terraform state. There is deliberately NO aws_iam_access_key
# resource here. This is the third narrow SES credential (R-PUB-6); never the
# box's creds, never the infra-account Mac identity.

data "aws_caller_identity" "current" {}

resource "aws_iam_user" "intake_mailer" {
  name = "aramo-public-intake-mailer"
  tags = local.common_tags
}

resource "aws_iam_user_policy" "intake_mailer_ses" {
  name = "aramo-public-intake-ses-send"
  user = aws_iam_user.intake_mailer.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "SendFromAramoSesIdentity"
        Effect = "Allow"
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail",
        ]
        Resource = "arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/${var.ses_identity_domain}"
      },
    ]
  })
}
