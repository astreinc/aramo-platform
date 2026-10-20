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

Tests: `node --test pre-signup/v2/index.test.mjs pre-signup/v2/harness/replay.test.mjs` (13 tests: 8 unit tests, plus 5 replays against redacted production shapes).

## Production-first validation (ruling 2026-10-20: no sandbox)

A private read-only backup was taken on 2026-10-20, outside the repo, chmod 700, with a SHA256SUMS manifest: `~/.aramo-cognito-backups/20261020-prod-first/`. It holds:
- both function configurations, code zips, versions, aliases and resource policies;
- the user pool, the app client and both identity providers;
- the groups and users, with their identity links.

The captured PreSignUp `index.mjs` matches `pre-signup/deployed-2025-12-18/index.mjs` (`58def2b9…`).

| Question | Evidence (read-only) | Result |
|---|---|---|
| Does Microsoft send `xms_edov`? | The `microsoft` provider maps `email_verified ← xms_edov`. The `aramo.ai` Microsoft user was created on 2025-12-29, after the deployed trigger and its environment (`ALLOWED_EMAIL_DOMAINS=astreinc.com`) were last modified on 2025-12-18. For any other domain that trigger returns the event untouched (`index.mjs:86-88`), so it did not verify this user's email. The user's `email_verified=true` therefore came from Microsoft's claim, and it was still true after a later sign-in (modified 2026-07-28). | **Observed for the configured Entra tenant.** One user in a verified domain; no other population can sign in through this provider (next row) |
| Who can use the `microsoft` provider? | `oidc_issuer = https://login.microsoftonline.com/d9f7bbd4-…/v2.0`: a single Entra tenant. Cognito checks the token issuer against it. | **Only accounts in that one Entra tenant.** A new Sign organization's own Microsoft 365 accounts **cannot** sign in through it. See the HALT note in the Gate-5 report |
| Google `email_verified` | The `Google` provider maps `email_verified ← email_verified`, a standard Google ID-token claim | Mapped from the provider. To be observed in the controlled canary (CUTOVER S5) |
| Existing users unaffected | PreSignUp runs only when Cognito creates a user. v2 imports no SDK and cannot edit users or links (`harness/replay.test.mjs`) | **Holds by construction.** Proven again at cutover by S1–S3 |
| Google with a Microsoft user's email | Replayed against every captured federated shape: allowed as its own user, with no link and no verification manufactured | **Holds** (`harness/replay.test.mjs`) |

The replay harness:
- `harness/capture-shapes.mjs` builds **redacted** event shapes from the private backup into `harness/captured-shapes.json`. That file holds attribute names, provider prefixes, `email_verified` values and which providers each user has linked. It holds no emails or identifiers.
- `harness/replay.test.mjs` replays v2 against them locally.

## Cutover procedure (needs separate approval)

Superseded by **`CUTOVER.md`**: code-only switch of `$LATEST`, a one-command rollback to the captured zip, and the preconditions and smoke tests. The summary below is kept for history.

1. Deploy v2 as a new function, `cognito-pre-signup-v2`, alongside the old one, with the same role minus the Cognito admin permissions it no longer needs.
2. Point the pool's PreSignUp trigger at v2. Rollback is pointing it back at `cognito-pre-signup-auto-link`.
3. Watch the decision log lines and sign-ins for the 5 federated users.

## The existing Google→Microsoft link: PRESERVED pending individual review

The production-first ruling (2026-10-20) says: do not remove the link yet. Establish which subject is authoritative, whether the link was intentional, and whether removing it would break access. Existing associations are reconciled explicitly, never rewritten automatically. v2 neither edits nor removes it.

Facts for the review (read-only, 2026-10-20):
- **Authoritative subject:** the `microsoft_*` Cognito user, created 2025-12-11 14:50 UTC. Its Microsoft identity is primary. The Google identity was linked *into* it, so a Google sign-in for this person carries this user's `sub`.
- **When and how linked:** the Google identity was linked 2025-12-18 20:12:54 UTC. That is 6 minutes after `cognito-pre-signup-auto-link` was last deployed (20:06:09 UTC). The pattern is consistent with a deliberate post-deploy test of the linking path by its owner.
- **Groups:** `platform-console` (the linking precondition `REQUIRE_DEST_GROUP`) and `us-east-1_4fKlnGfaW_Microsoft` (a Cognito provider group).
- **Effect under AUTH-SIGNIN-1:** the token for a Google sign-in names two providers, so Aramo treats the provider as `ambiguous`. That is refused **only** for enforced-pin (new Sign signup) tenants. This person's Astre access is unchanged.
- **Trigger logs:** CloudWatch (`/aws/lambda/cognito-pre-signup-auto-link`, no retention limit) holds only START/END/REPORT lines. The deployed code logs no event content, so no claim payloads exist to inspect.

**If the review decides to remove it** (needs separate approval):
1. `aws cognito-idp admin-disable-provider-for-user --user-pool-id us-east-1_4fKlnGfaW --user ProviderName=Google,ProviderAttributeName=Cognito_Subject,ProviderAttributeValue=<google sub from the backup>`.
2. Before running it, confirm with the person that they sign in with Microsoft and don't depend on Google sign-in.
