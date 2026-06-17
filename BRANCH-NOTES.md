# auth-superadmin-login — M7 auth-slice SOURCE

**Do NOT merge this branch wholesale.** Cherry-pick the reconcile /
email-verified / JWKS slice; this branch also carries a local-dev-only
"never-merge-to-main" commit.

Commits (newest first):
- `eb526dc` chore: gitignore local-dev-only files — review (mostly safe)
- `7339b99` fix(identity-test): owner-seed audit count 84 — MERGE-WORTHY
- `8882088` feat(auth): super-admin federated login slice
  (email_verified normalization + platform-owner seed +
  reconcile-by-verified-email + 4xx error semantics) — **the slice to cherry-pick**
- `971251a` chore(auth): local-dev enablement — callback 302 redirect,
  JWKS-from-issuer, vite dev proxy — **NEVER MERGE TO MAIN** (local-dev only)

Pushed as a safeguard backup (no PR, no merge). M7 owner: cherry-pick
`8882088` (+ `7339b99`), leave `971251a` behind.
