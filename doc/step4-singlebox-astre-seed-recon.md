# Step-4 — Single-Box Directive 2: The Astre seed — RECON + design

**Status:** recon complete · §A hinge resolved (LINKS — proceed) · baseline main `000784a`
**Branches:** `feat/step4-singlebox-d2-astre-seed` (seed, PR 2a) · `feat/step4-singlebox-d2b-anthropic-env-fallback` (PR 2b)

---

## A. ★ The reconcile-vs-seed hinge — SCENARIO 3 LINKS (proceed, no HALT)

The login flow ([apps/auth-service/src/app/auth/session-orchestrator.service.ts:148–191](../apps/auth-service/src/app/auth/session-orchestrator.service.ts#L148-L191)): Cognito authenticates → `resolveUser({provider:'cognito', provider_subject: sub})` → on a by-sub MISS, reconcile by the IdP-**verified** email (`cognito.email.trim().toLowerCase()`) via `findUserByEmail`; if found, `linkExternalIdentity(...)` then `user = existing`.

**Scenario 3 (the seeded owner's first login):** the seeded `purush@astreinc.com` user exists with `tenant_id`=Astre + `tenant_owner` role and **no Cognito sub**. First login:
1. `resolveUser` by the new Cognito sub → **MISS** (no `ExternalIdentity` row yet).
2. Reconcile: `findUserByEmail('purush@astreinc.com')` → **FINDS the seeded user**.
3. `linkExternalIdentity({user_id: existing.id, provider:'cognito', provider_subject: <new sub>, ...})` → the repository's idempotent upsert on the `(provider, provider_subject)` unique key. The pair is **absent**, so only the **create** branch runs → a new `ExternalIdentity` row links the sub to the **existing** user. ([identity.repository.ts:76–99](../libs/identity/src/lib/identity.repository.ts#L76-L99))
4. `user = existing` → the seeded user's `tenant_id` + `tenant_owner` role **survive intact**. **No duplicate is created.**

**Verdict: SCENARIO 3 LINKS.** This is the expected, designed purpose of reconcile-by-verified-email. **→ Proceed with §D** (seed the owner by email, no sub; first login links). No reconcile-spine change is needed; the HALT condition (duplicate) does NOT trigger.

**Scenario 2 (takeover) still holds:** `linkExternalIdentity`'s `update: {}` no-op refuses to re-point an already-linked sub. Proven by [auth-hardening-d2-reconcile.integration.spec.ts](../libs/identity/src/tests/auth-hardening-d2-reconcile.integration.spec.ts) test 2 (the mapping is unchanged; `email_snapshot` not rewritten).

**Two load-bearing seed constraints fall out of the trace:**
- **Email must be stored normalized.** `findUserByEmail` does `findUnique({where:{email}})` — an **exact** match, no stored-side normalization ([identity.repository.ts:101–104](../libs/identity/src/lib/identity.repository.ts#L101-L104)). The orchestrator looks up the lowercased+trimmed Cognito email, so the seeded `User.email` must be exactly `purush@astreinc.com` (already normalized).
- **No open JIT.** A reconcile email-miss returns `auth_error: user_not_provisioned` and creates nothing. So the owner login succeeds **only because** the seed provisioned the row — confirming the seed is load-bearing, and the box-only boundary (real Cognito + a verified `purush@astreinc.com`) is where the link is proven.

## B. Schema apply — reuse D5 db-sync

Apply all module migrations to the box Postgres via the D5 replayer `tools/db-sync-local.sh` (`npm run db:sync:local`). The box Postgres is the same shape as local, so the proven local mechanism applies cleanly. A prod-grade `migrate deploy` path is a platform / go-live-#2 concern (not this directive).

## C. Scope/role catalog seed — reuse `runIdentitySeed`

The established seed mechanism is `runIdentitySeed(prisma)` in [libs/identity/prisma/seed.ts](../libs/identity/prisma/seed.ts) — the exact path the integration tests use ([identity.integration.spec.ts](../libs/identity/src/tests/identity.integration.spec.ts), [platform.integration.spec.ts](../apps/platform-admin/src/tests/platform.integration.spec.ts)). It is fully **idempotent** (every write is an `upsert` keyed on a stable hardcoded UUID with `update: {}`). It seeds the **full catalog**: 85 scope keys, 14 roles, 468 RoleScope grants (verified by query against a freshly db-synced DB) — **no new scopes**, just running the established catalog into a fresh DB.

## D. Astre tenant + owner — minimal, additive

A new seed entrypoint [libs/identity/prisma/seed-astre.ts](../libs/identity/prisma/seed-astre.ts) (`runAstreSeed`) that:
1. Calls `runIdentitySeed(prisma)` — reuses the catalog wholesale (§C).
2. Idempotently upserts the **Astre tenant**, the **owner User** (`purush@astreinc.com`, no display drift, `is_active`), a **membership** (Astre, site-wide), and a **`tenant_owner` role assignment** — keyed on a distinct stable UUID namespace (`019000a0-…`). **No `ExternalIdentity`** (no sub — links on first login per §A).
3. Emits the three provisioning audits (tenant/user/membership created, actor = system service account), mirroring the dev seed's pattern.
- **Minimal:** no branches/clients/extra users — Astre self-configures via the shipped Settings surfaces post-login.
- **Idempotent:** re-running upserts by stable id with `update: {}`; safe even after the owner has logged in (the linked sub is never touched).

### ⚑ Flag for PO provisioning review (§G — PO reviews owner/tenant provisioning)
Reusing `runIdentitySeed` wholesale (the directive's "reuse that path") also seeds its **standard dev fixtures**: the `Aramo Dev Tenant`, `admin@aramo.dev` (a `tenant_admin`) linked to the fixed dev sub `fixed-dev-cognito-sub-01`, and the `Aramo Platform` sentinel tenant. On the box these are **inert** — `admin@aramo.dev` cannot log in (no real Cognito identity owns that sub or that mailbox; reconcile-by-email would need a verified `admin@aramo.dev` Cognito login, which does not exist). They are kept to honor "reuse the established mechanism" with zero changes to security-adjacent seed code. **If the PO prefers a scrubbed box** (catalog-only, no dev fixtures), the clean follow-up is a behavior-preserving `runIdentitySeed(prisma, { includeDevFixtures:false })` option — flagged here rather than unilaterally refactored under a normal-merge.

## E. Anthropic-key env-fallback (SEPARATE PR 2b)

[secret-cache.service.ts](../libs/ai-draft/src/lib/secrets/secret-cache.service.ts) `getAnthropicApiKey()` fetches from Secrets Manager (`aramo/${ARAMO_ENV}/anthropic-api-key`), which on Lightsail needs an AWS credential on the box. To keep the box **AWS-credential-free**, add an env fallback: **prefer `ANTHROPIC_API_KEY` from env if set, else** the Secrets Manager path (unchanged). Secrets Manager stays the platform path (go-live #2, Fargate task roles). Small additive change → **manual PO merge (AI-surface)**.

## F. Provability (local)

Seed runs against a local Postgres of the same shape as the box (db-sync replays the same migrations). Verify: catalog seeded; **Astre tenant + owner User created** with the right `tenant_id` + `tenant_owner` role + **no ExternalIdentity**; re-run does not duplicate. §E: `ANTHROPIC_API_KEY` set → used (no SM call); unset → SM path unchanged. **★ Box-only boundary:** the live owner login → reconcile → link (scenario 3) needs real Cognito → verified on the box (§5 checklist), not locally. Local proves the **seed state**; the box proves the **login links to it**.
