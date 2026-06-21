# Aramo Step-4 Directive 2 — compute / run layer (prod composition).
#
# Extends the data-plane (vpc/rds/s3/log-groups, in main.tf) with the run
# layer: ECR + Secrets Manager containers + ElastiCache Redis + the SG mesh
# + ECS cluster + ALB + the two Fargate services. Mirrors staging
# (staging is the rehearsal ground for this exact wiring).
#
# ★ CLOSES THE RECON GAP (§G): prod had NO IAM app principal (staging had an
# IAM user). Rather than copy the legacy IAM user, prod gets the
# compute-native principals — per-service task EXECUTION + task ROLES — and
# the api task role carries the résumé-bucket least-privilege policy
# directly (the migration the iam-app-principal README anticipated). So prod
# now has app principals, of the better kind.
#
# ★ Account-independent authoring. validate-clean now; apply-and-prove is
# gated on the AWS account. Apply incrementally: data plane first, then this.

# --- ECR: the D1 images push here ---
module "ecr_api" {
  source = "../../modules/ecr-repository"
  name   = "aramo-${var.environment}-api"
  tags   = local.common_tags
}

module "ecr_auth" {
  source = "../../modules/ecr-repository"
  name   = "aramo-${var.environment}-auth-service"
  tags   = local.common_tags
}

# --- Secrets Manager containers (values provisioned OUT-OF-BAND) ---
module "secrets" {
  source      = "../../modules/secrets-manager"
  environment = var.environment

  secret_names = {
    "database-url"          = "Postgres connection string (assembled from the RDS endpoint + master secret)"
    "auth-private-key"      = "RS256 PKCS#8 private key (auth-service signs session JWTs)"
    "auth-public-key"       = "RS256 SPKI public key (api + auth-service verify)"
    "auth-pkce-state-key"   = "AES-256-GCM key for the PKCE state cookie"
    "google-places-api-key" = "Google Places API key (address autocomplete)"
    "anthropic-api-key"     = "Anthropic API key (ai-draft; SDK-read at runtime)"
    # "stripe-secret-key"   = added with the billing/edge directive
  }

  tags = local.common_tags
}

# --- Compute-tier security groups (alb / service / redis + rds ingress) ---
module "app_security_groups" {
  source                = "../../modules/app-security-groups"
  environment           = var.environment
  vpc_id                = module.vpc.vpc_id
  rds_security_group_id = module.vpc.rds_security_group_id
  api_port              = var.api_container_port
  auth_port             = var.auth_container_port
  tags                  = local.common_tags
}

# --- ElastiCache Redis (BullMQ) ---
module "redis" {
  source             = "../../modules/elasticache-redis"
  environment        = var.environment
  subnet_ids         = module.vpc.private_app_subnet_ids
  security_group_ids = [module.app_security_groups.redis_security_group_id]
  node_type          = var.redis_node_type
  tags               = local.common_tags
}

# --- ECS cluster ---
module "ecs_cluster" {
  source      = "../../modules/ecs-cluster"
  environment = var.environment
  tags        = local.common_tags
}

# --- ALB (HTTP listener; HTTPS/DNS = the edge directive) ---
module "alb" {
  source                = "../../modules/alb"
  environment           = var.environment
  vpc_id                = module.vpc.vpc_id
  public_subnet_ids     = module.vpc.public_subnet_ids
  alb_security_group_id = module.app_security_groups.alb_security_group_id
  api_port              = var.api_container_port
  auth_port             = var.auth_container_port
  tags                  = local.common_tags
}

# --- Runtime config + secret wiring ---
locals {
  base_app_env = {
    NODE_ENV   = "production"
    ARAMO_ENV  = var.environment
    AWS_REGION = var.aws_region
  }

  api_env = merge(local.base_app_env, {
    PORT             = tostring(var.api_container_port)
    REDIS_URL        = module.redis.redis_url
    S3_RESUME_BUCKET = module.resume_bucket.bucket_name
  }, var.api_extra_env)

  auth_env = merge(local.base_app_env, {
    PORT = tostring(var.auth_container_port)
  }, var.auth_extra_env)

  api_secrets = {
    DATABASE_URL          = module.secrets.secret_arns["database-url"]
    AUTH_PUBLIC_KEY       = module.secrets.secret_arns["auth-public-key"]
    GOOGLE_PLACES_API_KEY = module.secrets.secret_arns["google-places-api-key"]
  }

  auth_secrets = {
    DATABASE_URL        = module.secrets.secret_arns["database-url"]
    AUTH_PRIVATE_KEY    = module.secrets.secret_arns["auth-private-key"]
    AUTH_PUBLIC_KEY     = module.secrets.secret_arns["auth-public-key"]
    AUTH_PKCE_STATE_KEY = module.secrets.secret_arns["auth-pkce-state-key"]
  }
}

# --- api service ---
module "ecs_service_api" {
  source = "../../modules/ecs-service"

  name           = "aramo-${var.environment}-api"
  service_name   = "api"
  cluster_id     = module.ecs_cluster.cluster_id
  image          = "${module.ecr_api.repository_url}:${var.api_image_tag}"
  container_port = var.api_container_port
  cpu            = var.api_cpu
  memory         = var.api_memory

  subnet_ids         = module.vpc.private_app_subnet_ids
  security_group_ids = [module.app_security_groups.service_security_group_id]
  target_group_arn   = module.alb.api_target_group_arn

  aws_region     = var.aws_region
  log_group_name = module.api_log_group.name

  environment_variables = local.api_env
  secrets               = local.api_secrets

  # The prod app principal (closes the recon gap): the résumé-bucket
  # least-privilege policy on the task role + the Anthropic key via SDK read.
  task_role_inline_policy_json = module.resume_bucket.app_iam_policy_json
  task_role_secret_arns        = [module.secrets.secret_arns["anthropic-api-key"]]

  tags = local.common_tags

  depends_on = [module.alb]
}

# --- auth-service ---
module "ecs_service_auth" {
  source = "../../modules/ecs-service"

  name           = "aramo-${var.environment}-auth-service"
  service_name   = "auth-service"
  cluster_id     = module.ecs_cluster.cluster_id
  image          = "${module.ecr_auth.repository_url}:${var.auth_image_tag}"
  container_port = var.auth_container_port
  cpu            = var.auth_cpu
  memory         = var.auth_memory

  subnet_ids         = module.vpc.private_app_subnet_ids
  security_group_ids = [module.app_security_groups.service_security_group_id]
  target_group_arn   = module.alb.auth_target_group_arn

  aws_region     = var.aws_region
  log_group_name = module.auth_log_group.name

  environment_variables = local.auth_env
  secrets               = local.auth_secrets

  tags = local.common_tags

  depends_on = [module.alb]
}
