# §5 Auth-Hardening D5 (3.6) Part B — local mock-IdP recon (REPORT, not built)

**Recon-only.** Per the directive, Part B (local browser-e2e auth) is reported
here for a Lead ruling; **nothing auth-related is built** in the Part A PR. The
binding constraint: any local-auth path must be **impossible in production** and
**must not be bypass-shaped** (the 302-hack lesson).

## Verdict: a clean mock-IdP path is FEASIBLE (not bypass-shaped) → propose + build as its own security-reviewed PR

The codebase already abstracts the IdP **entirely behind env + standard OIDC**,
so the **real auth code runs unchanged** against a local mock provider. There is
no skip-auth, no bypass endpoint, no flag — the only "local" thing is which URLs
the config names.

### Why it's clean (the real flow, unchanged)

The login path is plain OIDC Authorization-Code + PKCE, fully env-driven:

1. `GET /auth/:consumer/login` → 302 to `${AUTH_COGNITO_DOMAIN}/oauth2/authorize`
   (PKCE challenge + state). *(login())*
2. `GET /auth/:consumer/callback` → exchange code at `${AUTH_COGNITO_DOMAIN}/oauth2/token`
   for an `id_token`. *(session-orchestrator.exchangeCognitoCode)*
3. `CognitoVerifierService.verify` → `jose.jwtVerify` against the JWKS at
   **`${AUTH_COGNITO_ISSUER}/.well-known/jwks.json`**, checking `iss` =
   `AUTH_COGNITO_ISSUER`, `aud` = `AUTH_COGNITO_CLIENT_ID`, `RS256`, `exp`,
   `email`, `email_verified`, `token_use==='id'`.

A standard mock OIDC provider (e.g. `oauth2-mock-server`, `node-oidc-provider`,
or `cognito-local`) serves exactly these three shapes. Point the env at it:

| env | local mock value |
|---|---|
| `AUTH_COGNITO_DOMAIN` | the mock host (authorize + token) |
| `AUTH_COGNITO_ISSUER` | the mock issuer (drives `iss` check **and** JWKS URL) |
| `AUTH_COGNITO_CLIENT_ID` | a client id the mock accepts (= the token `aud`) |
| `AUTH_COGNITO_REDIRECT_URI` | the local callback |

The mock issues an RS256 `id_token` with `email_verified: true` (boolean → passes
the strict gate; `AUTH_TRUSTED_IDP_NAMES` not even needed), `token_use: id`,
`sub`, `email`. The e2e seed wires a recruiter `User` + `ExternalIdentity`
(`provider='cognito'`, `provider_subject=<mock sub>`) — the existing
`tools/provision-e2e-recruiter` / `link-e2e-recruiter-sub` already do this shape.

### Prod-impossibility (the binding constraint — satisfied by construction)

- **No code branch, no flag, no bypass.** Activation is *purely* config: which
  URLs `AUTH_COGNITO_*` name. Production config names real Cognito; a prod build
  has no awareness of any mock. There is nothing to "leave on."
- **Fail-closed.** Env unset → the verifier/orchestrator throw (or point at real
  Cognito); there is no default-to-mock. The auth logic is byte-identical in all
  environments. This is categorically safer than a login-bypass endpoint (which
  *is* the 302-hack class) — there is no bypass at all.

### One implementation wrinkle (call out for the build PR)

`login()` and `exchangeCognitoCode()` build the authorize/token URLs as
**`https://${domain}`** (scheme hardcoded). The JWKS URL is built from the
*issuer* (so `http://localhost:…` works there — jose fetches http fine), but
authorize + token need HTTPS. Two clean options for the build PR:

- **(preferred, config-only — real code untouched):** run the mock over HTTPS
  with a self-signed cert; the auth-service token-exchange `fetch` trusts it via
  `NODE_EXTRA_CA_CERTS` (config env), and Playwright uses `ignoreHTTPSErrors`.
- **(minimal code, still fail-closed):** an env-gated base-URL indirection
  (`AUTH_COGNITO_BASE_URL` defaulting to `https://${domain}`) so the mock can run
  on plain `http://localhost`. Touches the auth path, so weaker on the
  "real-code-unchanged" purity — the preferred option avoids it.

### Payoff if built — §5 staging-deferred checks that then run locally

- **D1** — recruiter login → genuine session → "My-X" surfaces (the literal
  browser login the D1 spec deferred).
- **D2** — federated reconcile-by-verified-email: the mock can emit a
  federated-shaped token (`identities[].providerName` + string `email_verified`)
  to exercise the reconcile path + the `AUTH_TRUSTED_IDP_NAMES` normalization
  end-to-end.
- **D3** — SSO logout: local clear + the `GET /logout` 302 to the mock's
  `/logout`; the literal "can't re-enter" is testable if the mock models its SSO
  cookie (otherwise still partial — real Cognito at staging remains the final word).

### Framing (so B isn't over-weighted)

Staging (Step 4) has **real Cognito**, so the D1/D2/D3 deferred checks are
verified there **regardless**. Part B is **dev-convenience / faster local
iteration, not a go-live blocker**. It's worth doing *because* it's a clean,
prod-impossible mock-IdP path — but it is correctly **deferrable** if the e2e
maintenance isn't a priority now.

## Recommendation

**Approve the mock-IdP path and build it as its own PR with a security review**
that asserts prod-impossibility (config-only activation; no code branch; fail-
closed; the HTTPS-mock option keeps the auth code unchanged). It is **not**
bypass-shaped, so no HALT — but per the directive it awaits an explicit Lead
ruling before any build. If dev-convenience isn't a priority, **defer** with this
recon as the carry; staging verifies the deferred checks either way.
