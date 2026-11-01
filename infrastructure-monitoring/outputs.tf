# Nothing secret: names and ARNs only. The publisher access key is created out of band.

output "ops_alert_topic_arn" {
  description = "MON_SNS_TOPIC_ARN for /etc/aramo/monitoring.conf on the box."
  value       = aws_sns_topic.ops_alerts.arn
}

output "publisher_user_name" {
  description = "IAM user for the box (create its access key out of band → /etc/aramo/monitoring.conf)."
  value       = aws_iam_user.publisher.name
}

output "metric_namespace" {
  description = "MON_METRIC_NAMESPACE for /etc/aramo/monitoring.conf."
  value       = var.metric_namespace
}

output "host_label" {
  description = "MON_HOST_LABEL for /etc/aramo/monitoring.conf (must match, or the watchdog reports a missing heartbeat)."
  value       = var.host_label
}

output "watchdog_function_name" {
  description = "Invoke by hand: aws lambda invoke --function-name <this> /dev/stdout"
  value       = aws_lambda_function.watchdog.function_name
}
