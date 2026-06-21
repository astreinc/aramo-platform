# Aramo Step-4 Directive 2 (compute IaC) — ECS Fargate service module.
#
# The run layer for ONE backend image (instantiated twice: api, auth-service).
# Bundles, per service:
#   - the task EXECUTION role (ECR pull + CloudWatch logs via the AWS managed
#     policy, + GetSecretValue on exactly the secrets this task injects)
#   - the task ROLE (the app's runtime AWS perms — an optional inline policy
#     such as the résumé-bucket least-privilege doc, + GetSecretValue on any
#     SDK-read secrets like the Anthropic key)
#   - the Fargate task definition (env-driven; NO secrets baked — plaintext
#     config in `environment`, secret material injected from Secrets Manager
#     via `secrets`)
#   - the ECS service in the private-app subnets, registered behind the ALB
#     target group, with the D1 TCP-probe wired as the container healthCheck
#
# This is the compute-native principal the iam-app-principal module README
# anticipated ("when a compute platform lands, MIGRATE to a task role"): the
# api task role carries the résumé-bucket policy directly — no IAM user.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

locals {
  # Distinct ARNs of the secrets injected as task env (execution role reads
  # these at task start). De-duplicated in case two env vars map to one secret.
  execution_secret_arns = distinct([for arn in values(var.secrets) : arn])

  # The D1 liveness probe (raw TCP connect to the service port) as the ECS
  # container healthCheck — zero app-code, identical to apps/*/Dockerfile.
  health_check_command = [
    "CMD-SHELL",
    "node -e \"const s=require('net').connect(Number(process.env.PORT)||${var.container_port},'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))\"",
  ]
}

# -----------------------------------------------------------------------------
# Task execution role — what ECS itself needs to START the task.
# -----------------------------------------------------------------------------
data "aws_iam_policy_document" "execution_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-exec"
  path               = "/aramo/ecs/"
  assume_role_policy = data.aws_iam_policy_document.execution_assume.json

  tags = merge(var.tags, { Name = "${var.name}-exec" })
}

# ECR pull + CloudWatch logs (the AWS-curated execution baseline).
resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# GetSecretValue on exactly the secrets this task injects (least-privilege —
# only created when the task actually injects secrets).
data "aws_iam_policy_document" "execution_secrets" {
  count = length(local.execution_secret_arns) > 0 ? 1 : 0

  statement {
    sid       = "ReadInjectedSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.execution_secret_arns
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count = length(local.execution_secret_arns) > 0 ? 1 : 0

  name   = "${var.name}-exec-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets[0].json
}

# -----------------------------------------------------------------------------
# Task role — what the APP's code is allowed to do against AWS at runtime.
# -----------------------------------------------------------------------------
resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  path               = "/aramo/ecs/"
  assume_role_policy = data.aws_iam_policy_document.execution_assume.json

  tags = merge(var.tags, { Name = "${var.name}-task" })
}

# Optional app runtime policy (e.g. the résumé-bucket least-privilege JSON
# from the s3-resume-bucket module). Null for services with no AWS perms.
resource "aws_iam_role_policy" "task_inline" {
  count = var.task_role_inline_policy_json == null ? 0 : 1

  name   = "${var.name}-task-policy"
  role   = aws_iam_role.task.id
  policy = var.task_role_inline_policy_json
}

# GetSecretValue for secrets the app reads via the AWS SDK at runtime (e.g.
# libs/ai-draft reads aramo/<env>/anthropic-api-key directly).
data "aws_iam_policy_document" "task_secrets" {
  count = length(var.task_role_secret_arns) > 0 ? 1 : 0

  statement {
    sid       = "ReadRuntimeSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = var.task_role_secret_arns
  }
}

resource "aws_iam_role_policy" "task_secrets" {
  count = length(var.task_role_secret_arns) > 0 ? 1 : 0

  name   = "${var.name}-task-secrets"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_secrets[0].json
}

# -----------------------------------------------------------------------------
# Task definition.
# -----------------------------------------------------------------------------
resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name      = var.service_name
      image     = var.image
      essential = true

      portMappings = [
        {
          containerPort = var.container_port
          protocol      = "tcp"
        },
      ]

      environment = [for k, v in var.environment_variables : { name = k, value = tostring(v) }]

      secrets = [for k, arn in var.secrets : { name = k, valueFrom = arn }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.log_group_name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = var.service_name
        }
      }

      healthCheck = {
        command     = local.health_check_command
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 40
      }
    },
  ])

  tags = merge(var.tags, { Name = var.name })
}

# -----------------------------------------------------------------------------
# Service.
# -----------------------------------------------------------------------------
resource "aws_ecs_service" "this" {
  name            = var.service_name
  cluster         = var.cluster_id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = var.deployment_minimum_healthy_percent
  deployment_maximum_percent         = var.deployment_maximum_percent

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = var.service_name
    container_port   = var.container_port
  }

  # First-apply convenience: don't fail the apply on the very first task
  # pull/boot taking a while. Operators can tighten later.
  lifecycle {
    ignore_changes = [desired_count]
  }

  tags = merge(var.tags, { Name = var.name })
}
