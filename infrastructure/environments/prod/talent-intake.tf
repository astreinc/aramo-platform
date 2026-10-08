# ADR-0033 — Talent Intake durable-event foundation (prod instantiation).
# AUTHORED, NOT APPLIED: the platform stack has never been applied; Terraform is
# applied ONLY from the Mac (the box hits the wrong AWS account). This wires the
# reusable modules/talent-intake-events: custom EventBridge bus + version-pinned
# rule → source SQS (+ consumer DLQ [Plane B] + EventBridge target DLQ [Plane A] +
# alarms) → container-image Lambda consumer, least-privilege IAM, guardrail-aligned
# timeouts/concurrency.

module "talent_intake_events" {
  source      = "../../modules/talent-intake-events"
  environment = var.environment
  tags        = local.common_tags

  # Container image for the consumer Lambda (set at apply via tfvars).
  lambda_image_uri = var.talent_intake_lambda_image_uri

  # Least-privilege artifact access (scoped to the résumé bucket + its CMK).
  resume_bucket_arn            = module.resume_bucket.bucket_arn
  resume_kms_key_arn           = module.resume_bucket.kms_key_arn
  tenant_llm_secret_arn_prefix = var.talent_intake_tenant_llm_secret_arn_prefix

  # The consumer Lambda needs VPC access to reach RDS (Postgres) for the
  # CAS/extraction persistence; the app service SG governs egress to RDS and
  # (via endpoints/NAT) S3 / Secrets Manager / the LLM endpoint.
  vpc_subnet_ids         = module.vpc.private_app_subnet_ids
  vpc_security_group_ids = [module.app_security_groups.service_security_group_id]

  alarm_actions = var.talent_intake_alarm_actions
}

# The api task role runs the outbox drain PUBLISHER → grant events:PutEvents to
# the Talent Intake bus ONLY (least privilege; the policy is scoped to this bus).
resource "aws_iam_role_policy_attachment" "api_talent_intake_publish" {
  role       = element(reverse(split("/", module.ecs_service_api.task_role_arn)), 0)
  policy_arn = module.talent_intake_events.publish_policy_arn
}
