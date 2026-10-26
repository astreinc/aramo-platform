# PreSignUp v2 — production cutover checklist (needs explicit approval at the checkpoint)

Governing: the Production-First Validation Ruling (Lead Architect, 2026-10-20); `Aramo-AUTH-SIGNIN-1-…-v1_0-LOCKED` R2/R7.

**Nothing below has been run.** Every command in §3 and §4 changes production and needs explicit approval at the cutover checkpoint.

## 1. Design: change the code, never the pool

- The pool `us-east-1_4fKlnGfaW` points its PreSignUp trigger at the **unqualified** ARN of `cognito-pre-signup-auto-link`, which runs `$LATEST`. The function has no published versions and no aliases (captured 2026-10-20).
- The cutover replaces that function's code. The pool configuration is **not** touched.
  - Do not use `aws cognito-idp update-user-pool`: it resets every setting the call leaves out.
- v2's defaults are the governed values: `ALLOWED_PROVIDERS=Google,microsoft`, `REQUIRE_PROVIDER_EMAIL_VERIFIED=true`. v2 ignores the old variables (`ALLOWED_EMAIL_DOMAINS`, `PRIMARY_IDP`, `REQUIRE_DEST_GROUP`, `USER_POOL_ID`).
- So the cutover is **one code update**, and the rollback is **one code update** back to the captured zip. No environment change is needed either way.

### Blast radius (canary isolation)

Cognito cannot scope a trigger to particular users. Per the ruling, this is therefore a **shared-production cutover**. Its reach is narrow by construction:
- PreSignUp runs only when Cognito **creates** a user. That means a first federated sign-in, or an admin-created user (`PreSignUp_AdminCreateUser`, which v2 passes through untouched).
- An **established** provider identity never invokes it: a returning `microsoft_*` user, a returning `google_*` user, the
  existing Google→Microsoft link and the native users. Their sign-ins, subjects and links cannot be changed by v2.
- An **existing person** can still invoke it (Lead Architect correction, 2026-10-26). When someone who already has a
  Cognito user signs in through a provider identity Cognito has never seen (for example, a Microsoft user's first Google
  sign-in), Cognito creates a new federated user and runs PreSignUp for it. That is exactly the path v2 changes.
- What changes for **new** federated users:
  - no automatic linking to an existing user with the same email;
  - no manufactured `email_verified`;
  - refusal when the provider has not verified the email.

### Identity cases (Lead Architect, 2026-10-26)

v2 governs the Cognito layer. Whether a new Cognito user reaches an existing **Aramo** user is decided separately, by the
auth-service email reconcile (`apps/auth-service/src/app/auth/identity-principal-directory.adapter.ts`) and the provider
policy R2 (`libs/identity/src/lib/identity-provider-policy.service.ts`). Both layers are listed.

| # | Case | PreSignUp runs? | Cognito outcome under v2 | Aramo outcome | Evidence |
|---|---|---|---|---|---|
| I-1 | Existing Microsoft identity signs in again | No | Same user, same `sub` | Resolves by sub, unchanged | S1 |
| I-2 | Existing Google identity signs in again | No | Same user, same `sub` | Resolves by sub, unchanged | S6 |
| I-3 | New Google identity, email matches an existing Microsoft user | Yes | New, separate Cognito user with its own `sub`; no link; `email_verified` only from Google | Email reconcile runs. **Refused** (`idp_identity_conflict`) when the existing Aramo user's links have a recorded provider. **Linked to the existing Aramo user** when its links are legacy (no recorded provider) and its tenant is not in the enforced-pin cohort: see the gap below | C3 replay (Cognito); S7 (Aramo) |
| I-4 | New Microsoft identity, email matches an existing Google user | Yes | As I-3, mirrored | As I-3, mirrored | C3 replay; S7 |
| I-5 | Existing manually linked identities (the Google→Microsoft link) | No | Link untouched; v2 has no code path that edits links | Resolves by sub, unchanged | S2; C3 replay |
| I-6 | Previously provisioned Aramo user with no Cognito user yet | Yes | New Cognito user, provider-verified email required | Email reconcile links it, subject to R2 and the enforced-pin cohort; no JIT for unknown emails (`user_not_provisioned`) | S5 |

**Aramo-layer gap (found 2026-10-26, needs a ruling; not changed by this cutover).** R2 treats links created before
AUTH-SIGNIN-1 as legacy and does not refuse a second provider for them. On 2026-10-26 production held 4 federated links:
1 with a recorded provider and 3 legacy (all `cognito` links, all in BUSINESS tenants, none in an enforced-pin tenant).
For those 3 users, case I-3/I-4 links the new provider's sign-in to their existing Aramo user, with its tenant
permissions. This is not a regression from v2: today the deployed trigger links the identity inside Cognito instead.
v2 removes the Cognito-level link; closing the Aramo-level path (for example, recording the provider on the 3 legacy
links) is a separate, authorized change.

## 2. Preconditions (all must hold; record each result)

| # | Check | Command / evidence |
|---|---|---|
| C1 | The private backup is present and intact | `cd ~/.aramo-cognito-backups/20261020-prod-first && shasum -a 256 -c SHA256SUMS` → all OK |
| C2 | The live code is still the captured code | `aws lambda get-function-configuration --function-name cognito-pre-signup-auto-link --region us-east-1 --query CodeSha256` = `P0+kBl0aFjN/BrfJkjE39FkBC0tfEvt9OclsntJt1aY=` |
| C3 | v2 tests and the replay against captured production shapes pass | `node --test infrastructure/cognito-triggers/pre-signup/v2/index.test.mjs infrastructure/cognito-triggers/pre-signup/v2/harness/replay.test.mjs` → 13/13 |
| C4 | The v2 artifact is built from the reviewed commit, and its hash is recorded | `cd infrastructure/cognito-triggers/pre-signup/v2 && rm -f /tmp/pre-signup-v2.zip && zip -X -j /tmp/pre-signup-v2.zip index.mjs && shasum -a 256 /tmp/pre-signup-v2.zip index.mjs` |
| C5 | A subject baseline exists for every existing user | from the backup: `python3 -c "import json;[print(u['Username'],[a['Value'] for a in u['Attributes'] if a['Name']=='sub'][0]) for u in json.load(open('users-and-identity-links.json'))['Users']]"` (keep it local; do not paste it into tickets) |
| C6 | Rollback zip check: its `index.mjs` hash matches the repo copy | `unzip -p ~/.aramo-cognito-backups/20261020-prod-first/cognito-pre-signup-auto-link.zip index.mjs \| shasum -a 256` = `58def2b9…cc4b7` |
| C7 | An operator and an Astre Microsoft user are available for smoke tests S1–S3 in the same window | PO |

## 3. Cutover (approval required at this checkpoint)

```bash
R=us-east-1; F=cognito-pre-signup-auto-link

# 3.1 Immutable rollback point of the current code. Behaviour-neutral: the pool still invokes $LATEST.
aws lambda publish-version --function-name "$F" --region "$R" \
  --description "pre-v2 rollback point: deployed 2025-12-18, index.mjs sha256 58def2b9" \
  --query '{Version:Version,CodeSha256:CodeSha256}'
#   Expect CodeSha256 = P0+kBl0aFjN/BrfJkjE39FkBC0tfEvt9OclsntJt1aY=. Record the Version.

# 3.2 Switch $LATEST to v2 (the single change)
aws lambda update-function-code --function-name "$F" --region "$R" \
  --zip-file fileb:///tmp/pre-signup-v2.zip --query '{CodeSha256:CodeSha256,LastModified:LastModified}'
aws lambda wait function-updated-v2 --function-name "$F" --region "$R"
aws lambda get-function-configuration --function-name "$F" --region "$R" \
  --query '{State:State,LastUpdateStatus:LastUpdateStatus,CodeSha256:CodeSha256,Runtime:Runtime,Handler:Handler}'
#   Expect Active / Successful, Runtime nodejs24.x, Handler index.handler, CodeSha256 = base64(sha256(/tmp/pre-signup-v2.zip))
```

## 4. Rollback (immediately executable; one command, about 10 seconds)

```bash
R=us-east-1; F=cognito-pre-signup-auto-link
aws lambda update-function-code --function-name "$F" --region "$R" \
  --zip-file fileb://$HOME/.aramo-cognito-backups/20261020-prod-first/cognito-pre-signup-auto-link.zip
aws lambda wait function-updated-v2 --function-name "$F" --region "$R"
aws lambda get-function-configuration --function-name "$F" --region "$R" --query CodeSha256
#   Must equal P0+kBl0aFjN/BrfJkjE39FkBC0tfEvt9OclsntJt1aY=
```

- The environment variables were never changed, so the restored code finds its original configuration.
- Users created while v2 was live stay as they are. Rollback restores behaviour; it does not rewrite users or links.

**Rollback criteria (any one is enough):**
- an existing user cannot sign in (S1/S2);
- any existing user's `sub` or identities differ from the C5 baseline;
- the function's `LastUpdateStatus` is not `Successful`;
- Lambda `Errors` exceed 0 for a sign-in the operator expected to succeed;
- Cognito shows `PreSignUp failed with error` for an identity that should be allowed.

## 5. Smoke tests in the same window (record each)

| # | Test | Pass condition |
|---|---|---|
| S1 | An Astre Microsoft user signs in at `astre.aramo.ai` (ATS) and at App Home | Signs in. Their `sub` (`aws cognito-idp admin-get-user … --query 'UserAttributes[?Name==\`sub\`]'`) equals the C5 baseline. No `pre-signup-v2` log line for them |
| S2 | The user with the existing Google→Microsoft link signs in with Microsoft | Same `sub`; `identities` still holds both entries (link preserved, not edited) |
| S3 | User count and links unchanged after S1–S2 | `aws cognito-idp list-users … --query 'length(Users)'` equals the live count recorded at C5 (9 on 2026-10-26: the 8 backup users plus one `google_*` user created after the backup); no identities changed |
| S4 | Decision log reachable | `aws logs filter-log-events --region us-east-1 --log-group-name /aws/lambda/cognito-pre-signup-auto-link --filter-pattern '"pre-signup-v2"' --start-time <cutover epoch ms>` shows only expected lines (none from S1–S3) |
| S5 (optional, creates one Cognito user) | An operator-controlled Google test account that has no Aramo user signs in once on `sign.aramo.ai` | v2 logs `allowed`; Aramo refuses with `user_not_provisioned` (no JIT); no link is made to any existing user. The created Cognito user is listed in the evidence (deleting it needs separate approval) |
| S6 (optional) | A user whose established identity is `google_*` signs in again (I-2) | Same `sub`; no `pre-signup-v2` log line for them |
| S7 (optional, creates one Cognito user) | An operator-controlled account of the other provider, whose provider-verified email matches an existing user, signs in once (I-3/I-4) | Cognito: a new, separate user with its own `sub`, no link (v2 logs `allowed`). Aramo: `idp_identity_conflict` when that user's links have a recorded provider; for a legacy-linked user this links to the existing Aramo user (the Aramo-layer gap in §1), so run S7 against a legacy-linked user only after that gap is closed |

## 6. Not part of this cutover

- Unlinking the existing Google→Microsoft association (preserved, pending separate review).
- Closing the Aramo-layer legacy-link gap in §1 (needs a ruling).
- Trimming the function role's Cognito admin permissions (v2 no longer needs them; a separate, later change).
- Any pool, app-client or provider change.
- Deploying the new signup code; public signup; live Stripe.
