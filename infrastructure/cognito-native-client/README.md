# Cognito native app client — `aramo-sign-native` (Sign Mobile P-5)

Governing:
- `Aramo-AUTH-SIGNIN-1-Amendment-M-A1-Native-Authentication-Consumer-v1_0-LOCKED` §6;
- the Lead Architect P-5 rulings of 2026-10-26: the settings, Option B (this root), and the G-089 dependency correction;
- `doc/runbooks/RELEASE-sign-mobile.md` §P-5.

This root manages **one** resource: the public Cognito app client `aramo-sign-native` used by the Aramo Sign iOS and
Android app. The existing user pool `aramo-platform` (`us-east-1_4fKlnGfaW`) is read through a data source only.

## What this root never touches

The pool and everything in it were created outside Terraform, and they stay that way:
- the user pool and its settings;
- the identity providers `Google` and `microsoft`;
- the PreSignUp and PreTokenGeneration Lambda triggers (G-089 is `infrastructure/cognito-triggers/CUTOVER.md`);
- the browser app client `aramo`.

None of them is a resource here, and nothing is imported. `terraform plan` for this root must show exactly
**1 to add, 0 to change, 0 to destroy** on first apply. Any other plan is drift: stop and report it.

## Settings (Lead Architect P-5 ruling)

| Setting | Value |
|---|---|
| Client type | Public, no secret |
| OAuth flow | Authorization code only; PKCE S256 (see `main.tf` for where it is enforced) |
| Scopes | `openid email profile` (what the app requests) |
| Providers | `Google`, `microsoft` (the exact deployed names) |
| Callback URLs | `https://sign.aramo.ai/auth/native/callback`, `aramosign://auth/callback` |
| Sign-out URL | `https://sign.aramo.ai/auth/native/signed-out` |
| Auth flows | `ALLOW_REFRESH_TOKEN_AUTH` only (no password, SRP or custom auth) |
| Access / ID token | 15 minutes / 15 minutes |
| Cognito refresh token | 30 days |
| Token revocation | Enabled |
| User existence errors | Prevented |

## State

S3 bucket `aramo-terraform-state-prod`, key `cognito-native-client/terraform.tfstate`, lock table
`aramo-terraform-locks`, encrypted. This is its own state file, separate from `lightsail/terraform.tfstate` and every
other key.

## Running it

Run from the Mac with the production AWS credentials. Never run it from the box: the box uses a different AWS
identity and is refused by the state bucket.

```bash
cd infrastructure/cognito-native-client
terraform init                    # must report the S3 backend, never local state
terraform plan -out=<path outside the repo>/p5.tfplan
terraform show <path>/p5.tfplan   # expect: 1 to add, 0 to change, 0 to destroy
```

Keep saved plans outside the repository. `apply` runs only from a reviewed saved plan, under explicit authorization.

## Activation is separate

Creating the client does not enable native sign-in. The client stays unused until:
1. G-089 is complete;
2. the native callback and sign-out routes are deployed and verified;
3. `SIGN_NATIVE_COGNITO_CLIENT_ID` is set on the box (P-7) and the app is built with the client id.

Each of these needs its own authorization.

## Rollback

`terraform destroy` in this root removes only `aramo-sign-native`. It needs explicit authorization.
