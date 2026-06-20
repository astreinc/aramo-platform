# Auth reconcile-spine RECON — `auth-superadmin-login` branch map

**Status:** read-only findings for the Lead. Nothing built, changed, or cherry-picked.
**Purpose:** ground truth for §5 Directive 2 (the reconcile-spine cherry-pick). Recommends **no** cherry-pick plan — facts only.

- **Branch:** `auth-superadmin-login` (push-backup; no PR, no merge)
- **Merge-base with main:** `c10ca92` (*Tasks FE — the last core recruiter surface*) — **old**: pre-Settings-D1–D5, pre-FE-consolidation, pre-recruiter-login
- **Current main:** `cb16dbb`
- **Commits since merge-base:** 5

> **Headline:** the wanted reconcile slice lives almost entirely in **`8882088`**. The "never-merge" commit **`971251a`** turns out to be **already-on-main or superseded in full** (JWKS-from-issuer landed independently; the 302 has a safer env-gated successor on main; the vite hunk targets a deleted app). The one security-critical subtlety the branch's own `BRANCH-NOTES.md` does **not** flag: **`8882088` ships a `linkExternalIdentity` that RE-POINTS** an existing sub — main deliberately landed the **no-op** version. The cherry-pick must drop the branch's repository hunk and wire the reconcile call to main's no-op.

---

## 1. Commit map

| Commit | Class | Files (hunks) | What it does |
|---|---|---|---|
| `971251a` chore(auth): local-dev enablement | **(b/c/d) — nothing to take** | `auth.controller.ts` (302) · `cognito-verifier.service.ts` (JWKS) · `apps/recruiter-console/vite.config.ts` (proxy) | Three separate-file hunks: **(b) 302 hack** — superseded by main's safer env-gated 302; **(c) JWKS-from-issuer** — *already identical on main*; **(d) vite dev proxy** — target app deleted (recruiter-console → ats-web). |
| `8882088` feat(auth): super-admin federated login slice | **(a) RECONCILE SLICE** (+ 1 embedded regression hunk) | `cognito-verifier.service.ts`, `session-orchestrator.service.ts`, `auth.controller.ts`, `identity.service.ts`, **`identity.repository.ts` ⚠**, `libs/identity/prisma/seed.ts`, +6 test files | The wanted slice: email_verified normalization (P1), platform-owner seed (P2), reconcile-by-verified-email (P3), 4xx classing (P4). **⚠ the `identity.repository.ts` hunk is a RE-POINT `linkExternalIdentity` — a security regression vs main's no-op; must be dropped.** |
| `7339b99` fix(identity-test): audit count → 84 | **(d) OTHER — test, stale** | `libs/identity/src/tests/identity.integration.spec.ts` | Corrects the owner-seed audit-count assertion to 84. Coupled to `8882088`'s seed. **The literal `84` is stale against current main** (main's seed grew far past the branch's 82 baseline). Recompute, don't copy. |
| `eb526dc` chore: gitignore local-dev files | **(d) OTHER — local-dev** | `.gitignore` | Ignores `.claude/scheduled_tasks.lock`, `tools/local-run-link.sh`. Harmless; local-dev-flavored; not part of the slice. |
| `df2f6a7` docs(branch): never-merge note | **(d) OTHER — docs** | `BRANCH-NOTES.md` | The author's own "do not merge wholesale; cherry-pick `8882088` (+`7339b99`), leave `971251a`" note. Not on main; a source-branch artifact. |

---

## 2. The security questions (answered from code)

### 2.1 `linkExternalIdentity` — **RE-POINT on the branch; NO-OP on main** ← the account-takeover question

**Branch `8882088` — `libs/identity/src/lib/identity.repository.ts` (the `update` branch RE-POINTS):**
```ts
const row = await this.prisma.externalIdentity.upsert({
  where: { provider_provider_subject: { provider: args.provider, provider_subject: args.provider_subject } },
  update: {
    user_id: args.user_id,          // ← RE-POINTS an existing (provider, sub) to a new user_id
    email_snapshot: args.email_snapshot,
  },
  create: { id: uuidv7(), provider: args.provider, provider_subject: args.provider_subject, user_id: args.user_id, email_snapshot: args.email_snapshot },
});
```
Its own docstring: *"create the row on first federated login, **or re-point/refresh email_snapshot if the sub already exists**."*

**Main `cb16dbb` — same method, `update: {}` (NO-OP, refuse-to-re-point):**
```ts
const row = await this.prisma.externalIdentity.upsert({
  where: { provider_provider_subject: { provider: args.provider, provider_subject: args.provider_subject } },
  update: {},                       // ← NO-OP: an existing (provider, sub) row is left untouched
  create: { id: uuidv7(), provider: args.provider, provider_subject: args.provider_subject, user_id: args.user_id, email_snapshot: args.email_snapshot },
});
```

**Call site — `session-orchestrator.service.ts` (branch `8882088`), fires ONLY on a by-sub resolve MISS:**
```ts
let user = await this.identity.resolveUser({ provider: 'cognito', provider_subject: cognito.sub });
if (user === null) {
  const normalizedEmail = cognito.email.trim().toLowerCase();
  const seeded = await this.identity.findUserByEmail(normalizedEmail);
  if (seeded === null) { return { kind: 'auth_error', reason: 'user_not_provisioned' }; }
  await this.identity.linkExternalIdentity({
    user_id: seeded.id, provider: 'cognito', provider_subject: cognito.sub, email_snapshot: cognito.email,
  });
  ...
  user = seeded;
}
```

**Finding.** Because the call runs **only when the sub did not resolve**, the upsert's **create** branch is the live path; the **update** (re-point) branch is **unreachable on the reconcile path** *and* is a latent takeover primitive for any other caller. Main's no-op create-branch is byte-equivalent for reconcile and forecloses re-pointing entirely. **The branch's `identity.repository.ts` hunk must NOT be cherry-picked; the reconcile must wire to main's existing no-op `IdentityRepository.linkExternalIdentity`.** (See §5 for the service-passthrough wiring.)

### 2.2 email_verified gating — **REQUIRED, fail-closed** (string-`"true"` only for configured trusted IdPs)

The reconcile only runs after `this.cognito.verify(idToken)` succeeds, and `verify()` **throws** unless the gate passes — **`cognito-verifier.service.ts` (`8882088`):**
```ts
if (!this.isEmailVerified(p)) { throw new CognitoVerificationError('email_not_verified'); }
...
private isEmailVerified(p: CognitoIdTokenClaims): boolean {
  if (p.email_verified === true) return true;                                  // native / already-normalized
  if (p.email_verified === 'true' && this.isTrustedFederation(p)) return true; // federated string, trusted only
  return false;                                                                // false / "false" / undefined → FAIL
}
private isTrustedFederation(p: CognitoIdTokenClaims): boolean {
  const configured = (process.env['AUTH_TRUSTED_IDP_NAMES'] ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (configured.length === 0) return false;                                   // empty config → nothing trusted (fail-closed)
  ... // matches identities[].providerName, else cognito:username "<Provider>_" prefix
}
```

**Finding.** An **unverified-email reconcile is not possible**: a native unverified email fails the strict boolean; a federated `"true"` passes only when the token presents a provider in `AUTH_TRUSTED_IDP_NAMES`; empty config trusts nothing. The reconcile then matches a **seeded** user by **normalized-exact** verified email; a non-match returns a clean 403 (no open JIT, no tenant auto-create). **Residual, for the Lead:** the string-form acceptance is only as trustworthy as the IdP named in `AUTH_TRUSTED_IDP_NAMES` actually verifying emails — an explicit operational trust decision (default empty = safe).

### 2.3 JWKS-from-issuer — **validates against the issuer's published JWKS; ALREADY ON MAIN**

Main `cb16dbb` `cognito-verifier.service.ts` already carries the issuer-keyed JWKS (identical to the branch's `971251a` hunk):
```ts
const jwks = this.resolveJwks(expectedIssuer);                 // keyed on issuer, not the hosted-UI domain
...
private resolveJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  if (this.cachedJwks !== undefined && this.cachedIssuer === issuer) { return this.cachedJwks; }
  const base = issuer.replace(/\/+$/, '');
  const url = new URL(`${base}/.well-known/jwks.json`);        // <iss>/.well-known/jwks.json (real pool's cognito-idp endpoint)
  ...
}
```
`AUTH_COGNITO_ISSUER`, when set, drives **both** the `iss` check and the JWKS URL. **Finding:** token validation is against the issuer's published JWKS (not a hardcoded/pinned key), and this is **already present on main** — the `971251a` JWKS hunk is redundant.

### 2.4 4xx classing — **no pre-auth account-existence oracle**

**`auth.controller.ts` (`8882088`) maps the orchestrator's `auth_error` reasons:**
```ts
const TOKEN_REASONS = new Set(['email_not_verified','missing_email','missing_sub','wrong_token_use']);
if (TOKEN_REASONS.has(result.reason)) throw new AramoError('INVALID_TOKEN','IdP token rejected',401,{requestId,details});
if (result.reason === 'no_active_tenant') throw new AramoError('TENANT_ACCESS_DENIED','No active tenant membership',403,{requestId,details});
throw new AramoError('INSUFFICIENT_PERMISSIONS','Identity not provisioned',403,{requestId,details}); // user_not_provisioned + default
```
Genuine faults (token-exchange, refresh-persist, JWT-sign, JWKS/network) stay `internal_error` → 500.

**Finding.** No username/password disclosure (this is federated — no password at this service). The `user_not_provisioned` / `no_active_tenant` reasons are surfaced **only to a caller who has already completed IdP authentication** (i.e. proven control of that email), so they reveal provisioning status **only for emails the caller already owns** — **not an enumeration oracle** for arbitrary accounts. Reasons are debuggable (`details.reason`) without leaking "user exists vs not" to an unauthenticated prober.

---

## 3. The 302 hack — location & isolatability

**Location — `apps/auth-service/src/app/auth/auth.controller.ts`, callback success branch (`971251a`):**
```ts
if (result.kind === 'success') {
  setAccessCookie(res, result.accessJwt);
  setRefreshCookie(res, result.refreshTokenPlaintext);
  // was: res.status(204).end();
  const postLogin = process.env['AUTH_POST_LOGIN_REDIRECT'] ?? 'http://localhost:4201/';  // ← hardcoded localhost fallback = the hack
  res.redirect(302, postLogin);
  return;
}
```

**Isolatability verdict: ISOLATABLE (and moot).**
- Within `971251a` the three concerns sit in **three different files** — the 302 (auth.controller.ts), JWKS (cognito-verifier.service.ts), and vite proxy (vite.config.ts) share a commit but **no file/hunk**. Entangled at commit level only; cleanly separable at file level.
- **Moot in practice:** main's callback success **already** 302-redirects via `AUTH_POST_LOGIN_REDIRECT` — but **throws if it is unset** (no `localhost` default). Main's version is the *safe successor*; the branch's hardcoded-`localhost` fallback is exactly the never-merge part. **Nothing from this hunk should be taken.**

> Note the one cross-commit textual coupling: `8882088`'s `auth.controller.ts` 4xx hunk and `cognito-verifier.service.ts` email_verified hunk are diffed **on top of** `971251a`. They live in **different regions** of those files than the 302/JWKS hunks, so they're logically independent — but a `git cherry-pick 8882088` carries `971251a` as its textual base for those two files. Expect to apply the 4xx + email_verified changes **by hunk**, not by raw cherry-pick. (See §5.)

---

## 4. Already-on-main delta

**Branch has, main lacks (the genuinely-missing reconcile slice):**
- Reconcile-by-verified-email at the callback (orchestrator `resolveUser`-miss → `findUserByEmail` → link → `user = seeded`).
- `email_verified` trusted-federation normalization + `CognitoVerificationError` typed class (verifier).
- 4xx `auth_error` classing (orchestrator union member + controller mapping).
- Platform-owner bootstrap seed (`purush@aramo.ai` → User + platform-sentinel membership + `super_admin`; **no `SEED_OWNER_EMAIL` / `user_owner` exists on main** — confirmed absent).
- `IdentityService.linkExternalIdentity` **passthrough** (main has the method on the repository only, not the service).

**Main has, supersedes/conflicts with the branch:**
- **No-op `IdentityRepository.linkExternalIdentity`** (main) vs **re-point** (branch) — §2.1. **Keep main's.**
- **JWKS-from-issuer** — already on main, identical (§2.3). Branch's `971251a` JWKS hunk redundant.
- **Safe env-gated post-login 302** (`AUTH_POST_LOGIN_REDIRECT`, throws if unset) vs branch's `localhost` fallback hack (§3).
- **FE consolidation:** `apps/recruiter-console` **deleted** → `apps/ats-web`. Branch's vite-proxy hunk targets a non-existent file.
- **Seed growth:** main `libs/identity/prisma/seed.ts` is **2509 lines** (branch base ~1700) from Settings D1–D5 + reporting/search scopes — moves every owner-seed anchor and invalidates the branch's audit-count.

**Reconcile-call dependencies — present on main (good):** `IdentityService.findUserByEmail` ✓, `IdentityService.resolveUser` ✓, `IdentityAuditService.writeGlobalEvent` ✓, orchestrator already injects `audit: IdentityAuditService` ✓ (no constructor change needed), seed ids `platform_tenant` (`…0100`) ✓ and `super_admin` role (`…001d`) ✓.

---

## 5. Staleness / conflict map (slice target files → current main)

| Slice file (`8882088`) | On main | Apply surface / conflict |
|---|---|---|
| `libs/identity/src/lib/identity.repository.ts` | no-op `linkExternalIdentity` at L76+ | **DROP the branch hunk entirely.** Do not re-point. Reconcile uses main's no-op. |
| `libs/identity/src/lib/identity.service.ts` | has `findUserByEmail` (L51), `resolveUser` (L44); **no** `linkExternalIdentity` passthrough | **TAKE** the passthrough (new method) — it delegates to the repo's (no-op) method; object-arg signatures match. Small offset, low conflict. |
| `apps/auth-service/src/app/auth/session-orchestrator.service.ts` | `resolveUser`-miss → `internal_error` at L129–139; `audit` already injected; union has no `auth_error` | **CONFLICT (logic rewrite).** Replace the miss block with reconcile+link, add `auth_error` union member + `CognitoVerificationError` import + flip `no_active_tenant`/`user_not_provisioned` to `auth_error`. Hand-apply at shifted lines. |
| `apps/auth-service/src/app/auth/cognito-verifier.service.ts` | **already** JWKS-from-issuer (L34/46/97) | **TAKE** the `8882088` email_verified normalization + `CognitoVerificationError` (independent region). **IGNORE** the `971251a` JWKS hunk (redundant). |
| `apps/auth-service/src/app/auth/auth.controller.ts` | success=env-gated 302 (L230), logout=204 (L333) | **CONFLICT.** Insert the `auth_error` → 4xx mapping before the `internal_error` throw (hand-apply at shifted lines). **DROP** the `971251a` 302 hack hunk. |
| `libs/identity/prisma/seed.ts` | 2509 lines; `platform_tenant`/`super_admin` ids exist; **no owner seed** | **Hand-apply at shifted anchors:** add `user_owner`/`membership_owner`/`membership_role_owner` ids + `SEED_OWNER_EMAIL`/`SEED_OWNER_DISPLAY_NAME` exports + 2 audit-event ids, and the runtime upserts (owner User, platform-sentinel membership, `super_admin` role-assign, 2 audit rows). Anchors moved (admin upserts now ~L2050–2125). |
| `libs/identity/src/tests/identity.integration.spec.ts` (`7339b99`) | audit-count assertion on main reflects post-Settings growth, **not** the branch's 82/84 | **Recompute** the count against current main (`+2` for the owner seed). Do **not** copy the literal `84`. |
| auth-service tests: `auth.controller.spec.ts`, `cognito-verifier.service.spec.ts`, `session-orchestrator.service.spec.ts`, `auth.integration.spec.ts`, `auth.site-axis.integration.spec.ts`; `libs/identity/src/tests/seed.spec.ts` | exist on main, evolved bases | Bring as **adapted** coverage (verifier normalization, reconcile+link round-trip, 4xx split, owner-seed proof, 204→302 callback). Expect offset/shape conflicts — port behavior, not literal hunks. |

---

## 6. The clean slice vs the hack vs other (ground truth — no plan recommended)

- **Clean reconcile slice (wanted, missing from main):** `8882088` — **minus** its `identity.repository.ts` re-point hunk — i.e. email_verified normalization + `CognitoVerificationError` (verifier), reconcile-by-verified-email + `auth_error` (orchestrator), 4xx mapping (controller), `IdentityService.linkExternalIdentity` passthrough (wired to main's **no-op** repo), platform-owner seed (seed.ts). Plus adapted tests. The audit-count delta (`7339b99`) recomputed against main.
- **The hack (leave behind):** `971251a` `auth.controller.ts` 302 (hardcoded `localhost`) — superseded by main's safe env-gated 302.
- **Already-on-main / redundant (do not re-introduce):** `971251a` JWKS hunk (identical on main); the re-point `linkExternalIdentity` (main's no-op supersedes); recruiter-console vite proxy (app deleted).
- **Other:** `eb526dc` (.gitignore, local-dev), `df2f6a7` (BRANCH-NOTES, source-branch artifact) — neither is part of the security slice.

**Two load-bearing cautions for Directive 2:**
1. **Do not let `linkExternalIdentity` re-point.** The takeover-safe posture on main is the no-op; the branch silently regresses it. Wire the reconcile to the landed no-op and drop the branch's repository hunk.
2. **`git cherry-pick 8882088` will not apply cleanly** — it is based on `971251a` for two shared files and on a pre-consolidation/pre-Settings tree for `seed.ts` + tests. This is a **hunk-level** graft, not a commit-level pick.
