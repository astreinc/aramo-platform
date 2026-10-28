# M-A8 §1.1.7 — daily backup-freshness check, WITHOUT CloudWatch alarm resources:
#   EventBridge rule (daily) → Lambda (lambda/freshness.py) → SNS topic → email.
#
# The Lambda alerts when the newest routine/ manifest is older than 26 h, the newest
# heartbeat/ object is not OK, or the newest PASS report in restore-checks/ is older
# than 35 days. It lists keys and HEADs objects for their metadata; it never reads an
# object body and holds no KMS permission (HeadObject does not decrypt).

locals {
  freshness_name = "aramo-prod-backup-freshness"
}

data "archive_file" "freshness" {
  type        = "zip"
  source_file = "${path.module}/lambda/freshness.py"
  output_path = "${path.module}/build/freshness.zip"
}

resource "aws_sns_topic" "backup_alerts" {
  name              = "aramo-prod-backup-alerts"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "backup_alerts_email" {
  topic_arn = aws_sns_topic.backup_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_log_group" "freshness" {
  name              = "/aws/lambda/${local.freshness_name}"
  retention_in_days = 90
}

data "aws_iam_policy_document" "freshness_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "freshness" {
  name               = local.freshness_name
  assume_role_policy = data.aws_iam_policy_document.freshness_assume.json
}

data "aws_iam_policy_document" "freshness" {
  # Keys only: routine/ (manifest listing), heartbeat/ and restore-checks/.
  statement {
    sid       = "ListMonitoredPrefixes"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["routine/*", "heartbeat/*", "${local.restore_checks_prefix}*"]
    }
  }

  # s3:GetObject authorises HeadObject. Limited to the two status prefixes; there is
  # no grant on routine/ or historic/ objects and no KMS grant at all.
  statement {
    sid     = "HeadStatusObjects"
    effect  = "Allow"
    actions = ["s3:GetObject"]
    resources = [
      "${local.bucket_arn}/heartbeat/*",
      "${local.bucket_arn}/${local.restore_checks_prefix}*",
    ]
  }

  statement {
    sid       = "PublishAlerts"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.backup_alerts.arn]
  }

  statement {
    sid       = "WriteOwnLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.freshness.arn}:*"]
  }
}

resource "aws_iam_role_policy" "freshness" {
  name   = "backup-freshness-read-keys-publish"
  role   = aws_iam_role.freshness.id
  policy = data.aws_iam_policy_document.freshness.json
}

resource "aws_lambda_function" "freshness" {
  function_name    = local.freshness_name
  description      = "Aramo backup-freshness check (M-A8 §1.1.7)"
  role             = aws_iam_role.freshness.arn
  runtime          = "python3.12"
  handler          = "freshness.handler"
  filename         = data.archive_file.freshness.output_path
  source_code_hash = data.archive_file.freshness.output_base64sha256
  timeout          = 60
  memory_size      = 128

  environment {
    variables = {
      BACKUP_BUCKET              = aws_s3_bucket.backups.bucket
      ALERT_TOPIC_ARN            = aws_sns_topic.backup_alerts.arn
      ROUTINE_MAX_AGE_HOURS      = tostring(var.routine_max_age_hours)
      RESTORE_CHECK_MAX_AGE_DAYS = tostring(var.restore_check_max_age_days)
    }
  }

  depends_on = [aws_cloudwatch_log_group.freshness, aws_iam_role_policy.freshness]
}

resource "aws_cloudwatch_event_rule" "freshness" {
  name                = local.freshness_name
  description         = "Daily Aramo backup-freshness check (M-A8 §1.1.7)"
  schedule_expression = var.freshness_schedule
}

resource "aws_cloudwatch_event_target" "freshness" {
  rule = aws_cloudwatch_event_rule.freshness.name
  arn  = aws_lambda_function.freshness.arn
}

resource "aws_lambda_permission" "freshness_from_eventbridge" {
  statement_id  = "AllowDailyEventBridgeRule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.freshness.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.freshness.arn
}
