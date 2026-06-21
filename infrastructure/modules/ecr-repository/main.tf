# Aramo Step-4 Directive 2 (compute IaC) — ECR repository module.
#
# One container registry repository per backend image (the D1 Dockerfiles
# push here: apps/api/Dockerfile → aramo-<env>-api, apps/auth-service/
# Dockerfile → aramo-<env>-auth). Instantiated once per image, mirroring
# the cloudwatch-log-group per-instance precedent.
#
# Posture:
#   - scan_on_push = true   (CVE surface on every push)
#   - a keep-last-N lifecycle policy (prune untagged + old images so the
#     registry doesn't grow unbounded)
#   - AES256 encryption at rest (account-default; a dedicated CMK is the
#     hardening option, not first-deploy)
#
# image_tag_mutability defaults to MUTABLE so a rolling `:latest`/`:staging`
# tag works for the first deploy; flip to IMMUTABLE (per-digest tags only)
# as a hardening follow-up.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Mutability is a VARIABLE defaulting to MUTABLE so a rolling :latest/:staging
# tag works for the first deploy. IMMUTABLE (per-digest tags) is exposed as the
# hardening flip; the ignore covers the default, not a hard choice.
#tfsec:ignore:aws-ecr-enforce-immutable-repository
resource "aws_ecr_repository" "this" {
  name                 = var.name
  image_tag_mutability = var.image_tag_mutability
  force_delete         = var.force_delete

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = merge(var.tags, { Name = var.name })
}

# Keep the last N images; expire older ones (untagged first, then tagged
# beyond the retention count). Caps registry growth for the rolling-tag flow.
resource "aws_ecr_lifecycle_policy" "this" {
  repository = aws_ecr_repository.this.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images beyond ${var.untagged_image_retention_count}"
        selection = {
          tagStatus   = "untagged"
          countType   = "imageCountMoreThan"
          countNumber = var.untagged_image_retention_count
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep only the last ${var.image_retention_count} images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.image_retention_count
        }
        action = { type = "expire" }
      },
    ]
  })
}
