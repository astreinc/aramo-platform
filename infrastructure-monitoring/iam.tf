# The box's publisher. NO aws_iam_access_key here: a secret would land in state. The key
# is created out of band after the apply and written to /etc/aramo/monitoring.conf
# (root:root 0600) on the box. Lightsail has no instance role, so the box uses a static
# IAM-user key, like the backup writer (infrastructure-backups/iam.tf).

resource "aws_iam_user" "publisher" {
  name = var.publisher_user_name
}

data "aws_iam_policy_document" "publisher" {
  statement {
    sid       = "PublishOpsAlerts"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.ops_alerts.arn]
  }

  # PutMetricData has no resource ARN; the namespace condition is the scope.
  statement {
    sid       = "PutProbeMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [var.metric_namespace]
    }
  }
}

resource "aws_iam_user_policy" "publisher" {
  name   = "monitoring-publish-only"
  user   = aws_iam_user.publisher.name
  policy = data.aws_iam_policy_document.publisher.json
}
