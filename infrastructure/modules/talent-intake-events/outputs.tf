output "event_bus_name" {
  description = "Custom Talent Intake EventBridge bus name (publisher targets this)."
  value       = aws_cloudwatch_event_bus.this.name
}

output "event_bus_arn" {
  description = "Custom Talent Intake EventBridge bus ARN."
  value       = aws_cloudwatch_event_bus.this.arn
}

output "publish_policy_arn" {
  description = "IAM policy ARN granting events:PutEvents to this bus only — attach to the api task role (least privilege)."
  value       = aws_iam_policy.publish.arn
}

output "source_queue_url" {
  description = "Talent Intake source SQS queue URL."
  value       = aws_sqs_queue.source.url
}

output "source_queue_arn" {
  description = "Talent Intake source SQS queue ARN."
  value       = aws_sqs_queue.source.arn
}

output "consumer_dlq_arn" {
  description = "Plane B DLQ ARN — SQS→Lambda processing failures."
  value       = aws_sqs_queue.consumer_dlq.arn
}

output "eventbridge_target_dlq_arn" {
  description = "Plane A DLQ ARN — EventBridge→SQS target delivery failures."
  value       = aws_sqs_queue.eventbridge_target_dlq.arn
}

output "rule_arn" {
  description = "EventBridge rule ARN that routes the canonical event to the queue."
  value       = aws_cloudwatch_event_rule.extraction_requested.arn
}

output "consumer_function_name" {
  description = "Talent Intake consumer Lambda function name."
  value       = aws_lambda_function.consumer.function_name
}

output "consumer_function_arn" {
  description = "Talent Intake consumer Lambda function ARN."
  value       = aws_lambda_function.consumer.arn
}

output "consumer_role_arn" {
  description = "Talent Intake consumer Lambda execution role ARN."
  value       = aws_iam_role.lambda_exec.arn
}
