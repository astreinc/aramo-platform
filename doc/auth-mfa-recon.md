# §5 Auth-Hardening D6 (3.5) — MFA: recon + policy (config, ~zero app-code)

**The last §5 increment.** MFA for **all users (admin + recruiter)**, enforced at
the **Cognito pool + hosted-UI** — not rebuilt in app code (Cognito's MFA is
proven; custom MFA logic would be worse). Recon-first; the outcome is the
expected **config + doc** one (no auth-flow change → no HALT).

## Policy (decided)

- **TOTP (authenticator app), REQUIRED**, for Cognito-**native** users
  (username/password), **pool-level**. TOTP over SMS: no SMS cost, stronger, no
  phone-number dependency.
- **ALL users — admin AND recruiter** (ratified; no role exempt — recruiters
  touch the most talent PII, so password-only on those accounts is the
  exposure this closes).
- Enrollment + challenge handled by the **Cognito hosted-UI** (the same hosted-UI
  the login flow already uses).

## Native-vs-federated split (honest posture — not a gap)

The pool has federated IdPs configured (verified: **Google** + **microsoft**
(OIDC)), so the split is real and applies:

- **Cognito-native users** (username/password) → **Cognito enforces TOTP** (pool
  policy + hosted-UI enrollment/challenge). This is the policy above.
- **Federated users** (Google / Microsoft) → **MFA is the IdP's responsibility.**
  Cognito does not authenticate federated users (the IdP does), so Cognito MFA
  cannot apply to them — they are MFA'd by their IdP (enterprise Google Workspace
  / Microsoft Entra typically enforce org MFA). Setting the pool to MFA=required
  does **not** break federated login (Cognito does not TOTP-challenge a federated
  sign-in). *This is how federated MFA works, not a gap.*
- Do **not** attempt to force Cognito MFA on a federated login — architecturally
  impossible (Cognito isn't the authenticator) and it would break federated login.

*(For Astre: recruiters via Google Workspace → Google's MFA covers them;
recruiters via Cognito-native → Cognito's TOTP covers them.)*

## The config-vs-code split (the recon answer)

| Concern | Where it lives |
|---|---|
| MFA enforcement (require TOTP) | **Cognito pool policy** (out-of-band; §E below) |
| TOTP enrollment (QR/secret), challenge on login, lost-device recovery | **Cognito hosted-UI** — entirely; the app never renders these |
| not-yet-enrolled state | **hosted-UI** forces `MFA_SETUP` before issuing the auth code → the app's `/callback` only ever receives a code for a fully-MFA'd session |
| MFA-completed token handling | **none** — an MFA-completed `id_token` is a normal token; `CognitoVerifierService` checks sig/iss/aud/email_verified/token_use and is unchanged; `SessionOrchestratorService` mints the session identically |
| federated users | **IdP** MFAs them; Cognito MFA does not apply (above) |

**Application code needed: NONE.** The auth code has zero MFA assumptions (the
only `challenge` in the codebase is PKCE `code_challenge`). MFA does not change
the auth LOGIC — Cognito enforces it and the app receives normally-issued
(MFA-completed) tokens. This is the correct architecture, complete (not a
half-build).

- **Optional, NOT built (no scope expansion):** surfacing MFA status / enrollment
  guidance in Settings → Security & SSO (currently a seam). Enforcement does not
  depend on it (the hosted-UI handles enrollment). Left as a seam.

## E. Out-of-band config — Step-4 deploy item

Apply to the **staging + prod** pools at deploy (the local pool may take it for
testing, but enforcement is verified at staging with real Cognito). Deterministic
apply:

```sh
aws cognito-idp set-user-pool-mfa-config \
  --user-pool-id <POOL_ID> \
  --mfa-configuration ON \
  --software-token-mfa-configuration Enabled=true \
  --region <REGION>
# MfaConfiguration=ON  → MFA REQUIRED (not OPTIONAL) for native users.
# SoftwareTokenMfaConfiguration.Enabled=true → TOTP.
# SMS is NOT enabled as an MFA factor (TOTP only — no SMS cost/phone dependency).
```

Baseline observed on the dev pool at recon time: `MfaConfiguration: "OFF"`
(SMS/SNS configured but MFA off) → flip to `ON` + TOTP per above. This sits
alongside the other per-env Cognito config items (callback URL, sign-out URL).

## F. Verification — honest boundary

- **App handling:** none built, so nothing app-side to test (the auth path is
  unchanged; an MFA-completed token verifies exactly as today).
- **Enforcement (TOTP enroll + challenge) → STAGING** (real Cognito hosted-UI),
  the same local-Cognito limitation as D1/D2/D3. **Do NOT fake the TOTP flow
  locally.** At staging confirm: a **native** user is forced to enroll TOTP and
  is challenged on login; a **federated** (Google/MS) user is IdP-MFA'd and is
  **not** Cognito-TOTP-challenged (the split behaves as documented).

## Exit

Policy decided + documented (TOTP required, all native users; federated → IdP);
config-vs-code split reported (config + hosted-UI, zero app code); pool-policy
filed as a Step-4 deploy item; enforcement verification honestly deferred to
staging. **§5 Auth-Hardening closes.**
