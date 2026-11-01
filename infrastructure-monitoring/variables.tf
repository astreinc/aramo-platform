variable "aws_region" {
  description = "Region of the topic, the Lambda, the metrics and the state parameter."
  type        = string
  default     = "us-east-1"
}

variable "alert_email" {
  description = "Address subscribed to the ops alert topic. No default: the PO confirms it at apply. AWS sends a confirmation mail that must be accepted before any alert arrives."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be an email address."
  }
}

variable "topic_name" {
  description = "SNS topic for every production alert (on-box probe + off-box watchdog)."
  type        = string
  default     = "aramo-prod-ops-alerts"
}

variable "publisher_user_name" {
  description = "IAM user whose access key goes into /etc/aramo/monitoring.conf on the box (sns:Publish to the topic + cloudwatch:PutMetricData in metric_namespace only)."
  type        = string
  default     = "aramo-prod-monitoring-publisher"
}

variable "metric_namespace" {
  description = "CloudWatch namespace the on-box probe publishes to (MON_METRIC_NAMESPACE)."
  type        = string
  default     = "Aramo/Prod"
}

variable "host_label" {
  description = "Host dimension value of the probe's metrics (MON_HOST_LABEL)."
  type        = string
  default     = "astre-prod"
}

variable "watchdog_schedule" {
  description = "EventBridge schedule of the off-box watchdog."
  type        = string
  default     = "rate(5 minutes)"
}

variable "url_checks" {
  description = "Public URLs the watchdog requests and the status codes that count as up. An unauthenticated read answering 401 proves the request reached the service behind nginx."
  type = list(object({
    name   = string
    url    = string
    expect = list(number)
  }))
  default = [
    { name = "tenant-spa", url = "https://astre.aramo.ai/", expect = [200] },
    { name = "auth-jwks", url = "https://astre.aramo.ai/.well-known/jwks.json", expect = [200] },
    { name = "api", url = "https://astre.aramo.ai/v1/tenant/settings", expect = [401] },
    { name = "sign-web", url = "https://sign.aramo.ai/", expect = [200] },
    { name = "sign-service", url = "https://sign.aramo.ai/v1/sign/legal/status", expect = [401] },
    { name = "platform-admin", url = "https://admin.aramo.ai/platform/me", expect = [401] },
  ]
}

variable "tls_hosts" {
  description = "Hosts whose served certificate the watchdog checks for expiry."
  type        = list(string)
  default     = ["astre.aramo.ai", "sign.aramo.ai", "admin.aramo.ai"]
}

variable "tls_min_days" {
  description = "Alert when a served certificate has fewer days left than this (certbot renews at 30)."
  type        = number
  default     = 14
}

variable "heartbeat_max_age_minutes" {
  description = "Alert when the on-box probe has not published ProbeHeartbeat for this long (the probe runs every 5 minutes)."
  type        = number
  default     = 20
}

variable "remind_hours" {
  description = "Re-send an alert for a check that keeps failing after this many hours."
  type        = number
  default     = 6
}
