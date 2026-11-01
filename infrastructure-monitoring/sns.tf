# The ONE production alert topic: the on-box probe (deploy/monitoring/aramo-health-probe.sh)
# and the off-box watchdog Lambda publish here; the PO's address receives email.
#
# Deliberately no CloudWatch alarm resources (same choice as infrastructure-backups/
# monitoring.tf): the probe and the watchdog decide and publish themselves, alerting on
# change with a reminder interval.

resource "aws_sns_topic" "ops_alerts" {
  name              = var.topic_name
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "ops_alerts_email" {
  topic_arn = aws_sns_topic.ops_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
