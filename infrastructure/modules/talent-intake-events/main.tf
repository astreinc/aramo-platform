# ADR-0033 Talent Intake durable-event foundation.
#
#   OutboxPublisherPort → EventBridge adapter → custom bus → rule
#     → Talent Intake SQS (+ consumer DLQ)  ─ Plane B (SQS→Lambda processing)
#     → EventBridge target DLQ              ─ Plane A (EventBridge→SQS delivery)
#     → Lambda consumer (container image, bounded concurrency, partial batch)
#
# Encryption: SSE-SQS (AWS-managed) — the envelopes carry ids/metadata, not dense
# PII (ADR-0033 avoids payload PII), so the account-default posture (ADR-0016
# Decision 7) applies; no dedicated CMK one-off.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

data "aws_partition" "current" {}

locals {
  name = "aramo-${var.environment}-talent-intake"
}

# --- Custom domain-event bus -------------------------------------------------

resource "aws_cloudwatch_event_bus" "this" {
  name = local.name
  tags = merge(var.tags, {
    Name    = local.name
    Purpose = "talent-intake-event-bus"
  })
}

# --- Queues: consumer DLQ (Plane B), EventBridge target DLQ (Plane A), source --

resource "aws_sqs_queue" "consumer_dlq" {
  name                      = "${local.name}-consumer-dlq"
  message_retention_seconds = var.dlq_retention_seconds
  sqs_managed_sse_enabled   = true
  tags = merge(var.tags, {
    Name         = "${local.name}-consumer-dlq"
    Purpose      = "talent-intake-consumer-dlq"
    FailurePlane = "B-sqs-lambda-processing"
  })
}

resource "aws_sqs_queue" "eventbridge_target_dlq" {
  name                      = "${local.name}-ebtarget-dlq"
  message_retention_seconds = var.dlq_retention_seconds
  sqs_managed_sse_enabled   = true
  tags = merge(var.tags, {
    Name         = "${local.name}-ebtarget-dlq"
    Purpose      = "talent-intake-eventbridge-target-dlq"
    FailurePlane = "A-eventbridge-sqs-delivery"
  })
}

resource "aws_sqs_queue" "source" {
  name                       = local.name
  visibility_timeout_seconds = var.visibility_timeout_seconds
  message_retention_seconds  = var.source_queue_retention_seconds
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.consumer_dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
  tags = merge(var.tags, {
    Name    = local.name
    Purpose = "talent-intake-source-queue"
  })
}

# --- Rule: route the versioned canonical event to the source queue -----------

resource "aws_cloudwatch_event_rule" "extraction_requested" {
  name           = "${local.name}-extraction-requested"
  event_bus_name = aws_cloudwatch_event_bus.this.name
  description    = "Route ${var.event_detail_type} from ${var.event_source} to the Talent Intake queue."
  # Match the canonical envelope fields the publisher actually emits. Pinned to a
  # single version so a future event version cannot silently re-route here.
  event_pattern = jsonencode({
    source        = [var.event_source]
    "detail-type" = [var.event_detail_type]
  })
  tags = merge(var.tags, { Name = "${local.name}-extraction-requested" })
}

resource "aws_cloudwatch_event_target" "to_queue" {
  rule           = aws_cloudwatch_event_rule.extraction_requested.name
  event_bus_name = aws_cloudwatch_event_bus.this.name
  target_id      = "talent-intake-queue"
  arn            = aws_sqs_queue.source.arn

  # Plane A: EventBridge could-not-deliver-to-target failures land here, kept
  # operationally DISTINCT from consumer processing failures (Plane B).
  dead_letter_config {
    arn = aws_sqs_queue.eventbridge_target_dlq.arn
  }
  retry_policy {
    maximum_event_age_in_seconds = 3600
    maximum_retry_attempts       = 10
  }
}

# --- Queue policies: only THIS rule may SendMessage --------------------------

resource "aws_sqs_queue_policy" "source" {
  queue_url = aws_sqs_queue.source.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowEventBridgeRuleOnly"
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.source.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.extraction_requested.arn } }
    }]
  })
}

resource "aws_sqs_queue_policy" "eventbridge_target_dlq" {
  queue_url = aws_sqs_queue.eventbridge_target_dlq.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowEventBridgeRuleDlqOnly"
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.eventbridge_target_dlq.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.extraction_requested.arn } }
    }]
  })
}

# --- Publisher policy: events:PutEvents to THIS bus only (attach to api role) -

resource "aws_iam_policy" "publish" {
  name        = "${local.name}-publish"
  description = "Allow events:PutEvents to the Talent Intake bus only (ADR-0033 least privilege)."
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "events:PutEvents"
      Resource = aws_cloudwatch_event_bus.this.arn
    }]
  })
  tags = merge(var.tags, { Name = "${local.name}-publish" })
}

# --- Consumer Lambda execution role (least privilege) ------------------------

resource "aws_iam_role" "lambda_exec" {
  name = "${local.name}-consumer"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = merge(var.tags, { Name = "${local.name}-consumer" })
}

resource "aws_iam_role_policy_attachment" "basic_logs" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "vpc_access" {
  count      = length(var.vpc_subnet_ids) > 0 ? 1 : 0
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy" "consume_queue" {
  name = "consume-source-queue"
  role = aws_iam_role.lambda_exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ChangeMessageVisibility",
      ]
      Resource = aws_sqs_queue.source.arn
    }]
  })
}

resource "aws_iam_role_policy" "read_artifacts" {
  count = var.resume_bucket_arn != "" ? 1 : 0
  name  = "read-resume-artifacts"
  role  = aws_iam_role.lambda_exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = "${var.resume_bucket_arn}/*"
    }]
  })
}

resource "aws_iam_role_policy" "decrypt_artifacts" {
  count = var.resume_kms_key_arn != "" ? 1 : 0
  name  = "decrypt-resume-artifacts"
  role  = aws_iam_role.lambda_exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt"]
      Resource = var.resume_kms_key_arn
    }]
  })
}

resource "aws_iam_role_policy" "read_tenant_llm_secret" {
  count = var.tenant_llm_secret_arn_prefix != "" ? 1 : 0
  name  = "read-tenant-llm-secret"
  role  = aws_iam_role.lambda_exec.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = var.tenant_llm_secret_arn_prefix
    }]
  })
}

# --- Consumer Lambda (container image) + SQS event source mapping ------------

resource "aws_lambda_function" "consumer" {
  function_name                  = "${local.name}-consumer"
  role                           = aws_iam_role.lambda_exec.arn
  package_type                   = "Image"
  image_uri                      = var.lambda_image_uri
  timeout                        = var.lambda_timeout_seconds
  reserved_concurrent_executions = var.reserved_concurrency

  environment {
    variables = merge(var.lambda_environment, {
      # The in-app LLM client timeout the handler enforces (< lambda timeout).
      LLM_CLIENT_TIMEOUT_SECONDS = tostring(var.llm_client_timeout_seconds)
      TALENT_INTAKE_QUEUE_URL    = aws_sqs_queue.source.url
      TALENT_INTAKE_EVENT_BUS    = aws_cloudwatch_event_bus.this.name
    })
  }

  dynamic "vpc_config" {
    for_each = length(var.vpc_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }

  tags = merge(var.tags, { Name = "${local.name}-consumer" })
}

resource "aws_lambda_event_source_mapping" "sqs" {
  event_source_arn        = aws_sqs_queue.source.arn
  function_name           = aws_lambda_function.consumer.arn
  batch_size              = var.event_source_batch_size
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = var.event_source_max_concurrency
  }
}

# --- Observability: TWO distinct failure planes ------------------------------

# Plane A — EventBridge → SQS target delivery.
resource "aws_cloudwatch_metric_alarm" "plane_a_failed_invocations" {
  alarm_name          = "${local.name}-A-eventbridge-failed-invocations"
  alarm_description   = "Plane A: EventBridge could not deliver ${var.event_detail_type} to the Talent Intake queue."
  namespace           = "AWS/Events"
  metric_name         = "FailedInvocations"
  dimensions          = { RuleName = aws_cloudwatch_event_rule.extraction_requested.name, EventBusName = aws_cloudwatch_event_bus.this.name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
  tags                = merge(var.tags, { FailurePlane = "A-eventbridge-sqs-delivery" })
}

resource "aws_cloudwatch_metric_alarm" "plane_a_target_dlq_depth" {
  alarm_name          = "${local.name}-A-eventbridge-target-dlq-depth"
  alarm_description   = "Plane A: messages landed in the EventBridge target DLQ (delivery failure)."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.eventbridge_target_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
  tags                = merge(var.tags, { FailurePlane = "A-eventbridge-sqs-delivery" })
}

# Plane B — SQS → Lambda → Talent Intake processing.
resource "aws_cloudwatch_metric_alarm" "plane_b_consumer_dlq_depth" {
  alarm_name          = "${local.name}-B-consumer-dlq-depth"
  alarm_description   = "Plane B: messages reached the consumer DLQ (repeated processing failure)."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.consumer_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
  tags                = merge(var.tags, { FailurePlane = "B-sqs-lambda-processing" })
}

resource "aws_cloudwatch_metric_alarm" "plane_b_lambda_errors" {
  alarm_name          = "${local.name}-B-consumer-errors"
  alarm_description   = "Plane B: Talent Intake consumer Lambda invocation errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.consumer.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
  tags                = merge(var.tags, { FailurePlane = "B-sqs-lambda-processing" })
}

resource "aws_cloudwatch_metric_alarm" "plane_b_oldest_message_age" {
  alarm_name          = "${local.name}-B-oldest-message-age"
  alarm_description   = "Plane B: source queue backlog — oldest message age exceeded threshold."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.source.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.oldest_message_age_alarm_seconds
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
  tags                = merge(var.tags, { FailurePlane = "B-sqs-lambda-processing" })
}
