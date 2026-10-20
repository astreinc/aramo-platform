# Release notes — AUTH-SIGNIN-1 unified sign-in + Sign federated owner signup

Governing documents:
- `Aramo-AUTH-SIGNIN-1-Unified-Branded-Sign-In-Directive-v1_0-LOCKED`;
- `Aramo-Sign-Signup-Federated-Owner-Directive-v1_2-LOCKED`;
- `Aramo-Subdomain-Identity-B-IdP-Routing-Directive-Amendment-A2-Enforced-Provider-Pin-Sign-Signup-Cohort-v1_0-LOCKED`.

**Merging and deploying need separate authorization.** So do any Cognito change (see `infrastructure/cognito-triggers/CUTOVER.md`) and public signup.

## What ships

- **One Aramo sign-in screen** at `/login` of ATS (`/ats/login`), App Home, Sign and the platform console:
  - "Continue with Microsoft" and "Continue with Google";
  - a pinned host shows only its provider;
  - an unauthenticated user now lands on this page instead of going straight to the IdP.
- **auth-service changes:**
  - `?idp=` on `/auth/{consumer}/login` (closed allowlist; a tenant's pin wins);
  - `GET /auth/{consumer}/login-options`;
  - the callback error redirect carries `consumer`, plus `reason` for provider-policy refusals.
- **Provider-pin enforcement for new Sign signup tenants only** (Amendment A2). Existing tenants, Astre included, are unchanged.
- **AUTH-SIGNIN-1 R2:** no new cross-provider link on email equality, for any tenant. Existing links are untouched.
- **Sign signup creates the owner without Cognito and without a password.** The done page offers Continue with Microsoft / Google.
- **Migration:** `20261020200000_sign_signup_idp_pin`, additive. It adds two new tables (`TenantIdentityProviderPolicy`, `ExternalIdentityIdp`) and alters no existing table.

## R3: temporary-password paths are broken by the federated-only app client (operational defect, recorded)

Since the PO removed `COGNITO` from the `aramo` app client (2026-10-20), no user can complete a Cognito temporary-password sign-in.

| Path | State | Gate |
|---|---|---|
| ATS tenant invites | Use the Pattern-2 federated invite (no password) | None needed; regression covered by the auth-service and API suites |
| Sign self-service signup | Fixed by this release (no Cognito user, no password) | Public signup stays disabled |
| Platform-console Pattern A owner provisioning (`platform-invitation.service.ts`, `AdminCreateUser`) | **Broken for password sign-in.** The invitee gets a temporary password they cannot use | **Operator procedure until a follow-up directive.** Provision only people who will sign in with Google or Microsoft (Aramo links them through the verified-email path), and tell them to ignore the Cognito temporary-password email |

## R5: ATS E2E test identities (not fixed here; needs authorization)

- `apps/ats-web/e2e/cognito-login.ts` signs in as the native users `admin` and `recruiter` with a password. That no longer works against the production app client.
- **Do not re-enable password sign-in on the production app client.**
- Remediation options. Each is a Cognito change that needs separate authorization:
  1. A **non-production app client** in the same pool with `COGNITO` enabled, used only by E2E. Its callback URLs must point at a non-production host.
  2. **Federated test accounts:** dedicated Google test accounts, with the E2E flow clicking "Continue with Google". This needs MFA- and CAPTCHA-free test accounts.
- Until then, the E2E sign-in suite is expected to fail at the provider step. After this release, `page.goto('/')` lands on the Aramo sign-in page rather than the Cognito form.

## Deploy prerequisites (when authorized)

1. **Apply the additive migration.** Re-seeding is not needed.
2. **Rebuild and recreate:** `api`, `auth`, `platform-admin`, `nginx` (all SPAs).
3. **No environment change.** `AUTH_TRUSTED_IDP_NAMES=Google,Microsoft` stays as it is.
4. **PreSignUp v2 cutover:** a separate checkpoint, with its own approval (`CUTOVER.md`).
5. **Before public signup:** clear directive v1.2 §4 (Microsoft reachability decision, cutover done, link review).
