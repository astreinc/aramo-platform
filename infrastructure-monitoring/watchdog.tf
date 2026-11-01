# Off-box watchdog: EventBridge (every 5 minutes) → Lambda (lambda/watchdog.py) → SNS.
# Checks the public URLs, the served certificates and the on-box probe heartbeat, from
# outside the box. Alert state lives in one SSM parameter.

locals {
  watchdog_name   = "aramo-prod-watchdog"
  state_parameter = "/aramo/monitoring/watchdog-state"
}

data "archive_file" "watchdog" {
  type        = "zip"
  source_file = "${path.module}/lambda/watchdog.py"
  output_path = "${path.module}/build/watchdog.zip"
}

resource "aws_ssm_parameter" "watchdog_state" {
  name        = local.state_parameter
  description = "Aramo watchdog alert state (check -> failing-since, last-notified). Written by the Lambda."
  type        = "String"
  value       = "{}"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_cloudwatch_log_group" "watchdog" {
  name              = "/aws/lambda/${local.watchdog_name}"
  retention_in_days = 30
}

data "aws_iam_policy_document" "watchdog_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "watchdog" {
  name               = local.watchdog_name
  assume_role_policy = data.aws_iam_policy_document.watchdog_assume.json
}

data "aws_iam_policy_document" "watchdog" {
  statement {
    sid       = "PublishAlerts"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.ops_alerts.arn]
  }

  # GetMetricStatistics has no resource ARN.
  statement {
    sid       = "ReadProbeHeartbeat"
    effect    = "Allow"
    actions   = ["cloudwatch:GetMetricStatistics"]
    resources = ["*"]
  }

  statement {
    sid       = "OwnState"
    effect    = "Allow"
    actions   = ["ssm:GetParameter", "ssm:PutParameter"]
    resources = [aws_ssm_parameter.watchdog_state.arn]
  }

  statement {
    sid       = "WriteOwnLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.watchdog.arn}:*"]
  }
}

resource "aws_iam_role_policy" "watchdog" {
  name   = "watchdog-check-publish"
  role   = aws_iam_role.watchdog.id
  policy = data.aws_iam_policy_document.watchdog.json
}

resource "aws_lambda_function" "watchdog" {
  function_name    = local.watchdog_name
  description      = "Aramo off-box watchdog: public URLs, TLS expiry, on-box probe heartbeat"
  role             = aws_iam_role.watchdog.arn
  runtime          = "python3.12"
  handler          = "watchdog.handler"
  filename         = data.archive_file.watchdog.output_path
  source_code_hash = data.archive_file.watchdog.output_base64sha256
  timeout          = 120
  memory_size      = 128

  environment {
    variables = {
      URL_CHECKS                = jsonencode(var.url_checks)
      TLS_HOSTS                 = jsonencode(var.tls_hosts)
      TLS_MIN_DAYS              = tostring(var.tls_min_days)
      METRIC_NAMESPACE          = var.metric_namespace
      HOST_LABEL                = var.host_label
      HEARTBEAT_MAX_AGE_MINUTES = tostring(var.heartbeat_max_age_minutes)
      REMIND_HOURS              = tostring(var.remind_hours)
      STATE_PARAMETER           = aws_ssm_parameter.watchdog_state.name
      ALERT_TOPIC_ARN           = aws_sns_topic.ops_alerts.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.watchdog, aws_iam_role_policy.watchdog]
}

resource "aws_cloudwatch_event_rule" "watchdog" {
  name                = local.watchdog_name
  description         = "Aramo off-box watchdog schedule"
  schedule_expression = var.watchdog_schedule
}

resource "aws_cloudwatch_event_target" "watchdog" {
  rule = aws_cloudwatch_event_rule.watchdog.name
  arn  = aws_lambda_function.watchdog.arn
}

resource "aws_lambda_permission" "watchdog_from_eventbridge" {
  statement_id  = "AllowScheduledEventBridgeRule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.watchdog.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.watchdog.arn
}
