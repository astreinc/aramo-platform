# Cognito triggers — version-controlled source (governed)

Governing:
- `Aramo-AUTH-SIGNIN-1-Unified-Branded-Sign-In-Directive-v1_0-LOCKED` (R2, R7);
- the Lead Architect HALT disposition of 2026-10-20 (Option A) for `Aramo-Sign-Signup-Federated-Owner`.

**Nothing in this folder changes production by itself.** Attaching a trigger to the pool, deploying a new function version, or unlinking identities each need separate security and deployment approval.

Pool: `us-east-1_4fKlnGfaW` (`aramo-platform`), app client `aramo`. Federated providers: `Google` (type Google) and `microsoft` (OIDC, single-tenant Entra issuer). The pool and its triggers were created outside Terraform.

## What is deployed today (captured 2026-10-20, read-only)

| Trigger | Function | Source here | Notes |
|---|---|---|---|
| PreSignUp | `cognito-pre-signup-auto-link` (nodejs24.x, modified 2025-12-18) | `pre-signup/deployed-2025-12-18/index.mjs` (sha256 `58def2b9…`; deployment zip sha256 `3f4fa406…`) | env: `ALLOWED_EMAIL_DOMAINS=astreinc.com`, `PRIMARY_IDP=Microsoft`, `REQUIRE_DEST_GROUP=platform-console`, `USER_POOL_ID` |
| PreTokenGeneration (V2_0) | `cognito-pre-token-generation` (python3.14, modified 2025-12-06) | `pre-token-generation/deployed-2025-12-06/lambda_function.py` (sha256 `bc56327f…`; zip `edb46530…`) | Adds an `account_id` claim to **access** tokens only, when `custom:account_id` exists. No change to `sub`, `email` or `email_verified`. **No conflict**, so it is kept as is |

### What the deployed PreSignUp does (and why it is being replaced)

On `PreSignUp_ExternalProvider`, and only for emails at `astreinc.com`, because of `ALLOWED_EMAIL_DOMAINS`:
- **Primary provider (`Microsoft`):** it sets `autoConfirmUser` and `autoVerifyEmail` without checking the provider's own verification (`index.mjs:94-97`).
- **Other providers (Google):** it finds an existing Cognito user with the same email, preferring `microsoft_*`. If that user is in the `platform-console` group, it calls **`AdminLinkProviderForUser`**, linking the Google identity into that user (`:115-128`). After that, a Google sign-in carries the **existing user's `sub`**: subject substitution. It also auto-verifies the email (`:103-104`, `:130-131`).
- **Domains other than `astreinc.com`:** the event passes through unchanged (`:86-88`). So new Sign signup organizations on other domains are **not** affected by the linking today.

This conflicts with AUTH-SIGNIN-1 R2: no cross-provider merging on email equality, and no manufactured verification.

### Users in the pool (aggregate, 2026-10-20)

- **5 federated users** (`microsoft_*`). 4 are at `astreinc.com` and 1 at `aramo.ai`. All have `email_verified=true`, set at creation by the deployed trigger.
- **1 of those 5 has a linked `Google` identity**: a Google→Microsoft link made by the deployed trigger. Google sign-ins for that person carry the Microsoft user's subject. *This is the one existing unsafe association*; see the recovery procedure below.
- **3 native password users** (`purush`, `admin`, `recruiter`). The app client no longer allows password sign-in (`SupportedIdentityProviders = Google, microsoft`). `admin` and `recruiter` are the ATS e2e test identities (AUTH-SIGNIN-1 R5).

## The replacement: `pre-signup/v2/`

`v2/index.mjs` is dependency-free and makes **no Cognito API calls**:

| Invariant (HALT disposition A) | How v2 enforces it |
|---|---|
| No cross-provider linking on email equality | Never calls `AdminLinkProviderForUser` |
| No subject substitution | No linking, so a new federated user always keeps its own subject |
| Verified evidence comes from the provider only | Never sets `autoVerifyEmail`. With `REQUIRE_PROVIDER_EMAIL_VERIFIED=true` (the default), a first federated sign-in whose mapped `email_verified` is not `true` is **refused** before any Cognito user is created |
| Existing legitimate associations preserved | Runs only when a **new** federated user is created; never edits or removes existing users or links |
| First-time binding of a pre-provisioned Aramo user | Done in Aramo (provider-checked ExternalIdentity under AUTH-SIGNIN-1 R1/R2), not by Cognito linking |
| No-JIT | Unchanged: Aramo refuses unprovisioned emails (`user_not_provisioned`) |
| One user, one tenant | Unchanged (Aramo, IC-1) |
| Auditable outcomes | One structured CloudWatch line per decision: `allowed`, `refused_provider`, `refused_no_email` or `refused_unverified_email`, with provider, email domain only, and the provider-verified flag |

Tests: `node --test pre-signup/v2/` (8 tests, using real PreSignUp_ExternalProvider event shapes).

## Open questions sandbox validation must answer (HALT disposition D)

1. **Does Microsoft send `xms_edov`?** The pool maps Microsoft's `email_verified` from the optional `xms_edov` claim. If the Entra app registration doesn't emit it, new Microsoft users would arrive with no verified flag, and v2 (default) would refuse them. If so, there are two options:
   - configure `xms_edov` as an optional claim in the Entra app registration (preferred; it's the provider's own evidence);
   - or get a ruling on a Microsoft-specific verification source, for example single-tenant issuer trust.

   **Do not** just set `REQUIRE_PROVIDER_EMAIL_VERIFIED=false`.
2. **Google:** confirm `email_verified` is `true` for Google Workspace accounts.
3. **Existing Microsoft users** keep signing in with an unchanged `sub`. PreSignUp doesn't run for existing users, so this is expected; prove it.
4. **A Google sign-in matching a Microsoft user's email** creates a *separate* Cognito user, with its own `sub`, which Aramo refuses or does not grant privileges to.

**Sandbox needs** (production is not touched):
- A sandbox user pool with v2 attached.
- A sandbox Google OAuth client and a Microsoft Entra app registration (or the existing ones, with the sandbox pool's redirect URI added).
- One Google Workspace and one Microsoft 365 test account.

The IdP-side credentials are **PO actions**.

## Cutover procedure (needs separate approval; for reference only)

1. Deploy v2 as a new function, `cognito-pre-signup-v2`, alongside the old one, with the same role minus the Cognito admin permissions it no longer needs.
2. Point the pool's PreSignUp trigger at v2. Rollback is pointing it back at `cognito-pre-signup-auto-link`.
3. Watch the decision log lines and sign-ins for the 5 federated users.

## Recovery procedure for the existing Google→Microsoft link (needs separate approval)

The linked Google identity on one `microsoft_*` user lets a Google sign-in assume that user's subject.

**Option 1: keep the link, accept it consciously.** The link was made for a `platform-console`-group Astre user under the old policy. Record the exception and remove it later. Aramo-side enforcement can't tell the two providers apart for this user, because Cognito has already merged them.

**Option 2 (recommended): remove the link.**
1. Run `AdminDisableProviderForUser` (`ProviderName=Google`, `ProviderAttributeName=Cognito_Subject`, value = the Google user id) on the pool.
2. The person then signs in with Microsoft (their primary). A later Google sign-in would create a separate Google user, which Aramo does not link (AUTH-SIGNIN-1 R2).
3. Before running: confirm this person signs in with Microsoft today and doesn't depend on Google sign-in.

This procedure doesn't apply until it's approved.
