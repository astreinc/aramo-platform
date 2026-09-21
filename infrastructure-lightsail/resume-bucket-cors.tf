# Résumé-upload CORS (incident 2026-09-21).
#
# The Add-Talent résumé upload is a browser -> S3 DIRECT PUT via a presigned URL.
# That cross-origin PUT requires a CORS configuration on the résumé bucket
# allowing the app origin. The prod bucket (aramo-prod-resumes-use1) had NO CORS
# (`aws s3api get-bucket-cors` -> NoSuchCORSConfiguration), so every upload's
# preflight failed and the flow died before reaching /draft-from-resume — with
# zero server-side errors. The staging bucket already has the equivalent CORS
# (origin http://localhost:4201), which is why local worked and prod did not.
#
# The bucket itself is currently created out-of-band (NOT in this lightsail state,
# and the environments/prod ECS Terraform was never applied). This is a STANDALONE
# `aws_s3_bucket_cors_configuration` — it manages ONLY the CORS of the existing
# bucket by name, WITHOUT importing/managing the bucket (or its KMS key, lifecycle,
# or policy), so there is no risk to the PII objects. Bringing the full bucket
# under IaC is a separate, careful import project.
#
# Mirrors infrastructure/modules/s3-resume-bucket/main.tf: PUT/GET/HEAD;
# Content-Type/Content-Length/Authorization; NEVER "*" (PII-floor: open CORS is
# rejected). Origin is the real app front door (https://astre.aramo.ai), matching
# infrastructure/environments/prod/terraform.tfvars.
resource "aws_s3_bucket_cors_configuration" "prod_resumes" {
  bucket = "aramo-prod-resumes-use1"

  cors_rule {
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_origins = ["https://astre.aramo.ai"]
    allowed_headers = ["Content-Type", "Content-Length", "Authorization"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}
