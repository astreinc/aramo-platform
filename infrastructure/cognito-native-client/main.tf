# The existing production user pool, READ ONLY. A data source never creates,
# imports, modifies or replaces the pool, its identity providers or its Lambda
# triggers. It exists so that a wrong pool id fails the plan instead of the apply.
data "aws_cognito_user_pool" "aramo_platform" {
  user_pool_id = var.user_pool_id
}

# aramo-sign-native — the PUBLIC app client used by the Aramo Sign iOS and Android
# app (AUTH-SIGNIN-1 Amendment M-A1; Lead Architect P-5 ruling, 2026-10-26).
#
#   - Public client: no secret, because an app on a phone cannot keep one.
#   - Authorization code flow only. PKCE S256 is enforced end to end: the app always
#     sends code_challenge_method=S256 (mobile/sign/src/auth/authorize.ts), the
#     auth-service native token endpoint refuses an exchange without a valid
#     code_verifier (libs/auth-core/src/lib/native-auth.service.ts), and Cognito
#     checks the verifier against the challenge. Cognito has no per-client setting
#     that makes PKCE mandatory.
#   - No password, SRP or custom auth flows: Google and Microsoft only.
#   - Tokens: access 15 min, ID 15 min, Cognito refresh 30 days. Aramo issues its
#     own rotated device-session refresh token after the code exchange.
#   - The browser client `aramo` is a different resource that this root does not
#     know about, so it cannot be changed from here.
#
# Creating this client does not activate native sign-in. It stays unused until
# G-089 is complete and SIGN_NATIVE_COGNITO_CLIENT_ID is configured (separately
# authorized).
resource "aws_cognito_user_pool_client" "aramo_sign_native" {
  name         = "aramo-sign-native"
  user_pool_id = data.aws_cognito_user_pool.aramo_platform.id

  generate_secret = false

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["Google", "microsoft"]

  callback_urls = [
    "https://sign.aramo.ai/auth/native/callback",
    "aramosign://auth/callback",
  ]
  logout_urls = [
    "https://sign.aramo.ai/auth/native/signed-out",
  ]

  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH"]

  access_token_validity  = 15
  id_token_validity      = 15
  refresh_token_validity = 30
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  enable_token_revocation       = true
  prevent_user_existence_errors = "ENABLED"
}
