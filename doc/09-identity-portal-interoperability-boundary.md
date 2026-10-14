# 09 — Identity ↔ Talent Portal interoperability boundary (IC-4 PR-9)

**Status:** documented interface, enforced by tests. No account linking, identity merging, consent aggregation or portal SSO activation exists or is authorized; each of those requires its own LOCKED contract (IC-0 §H option 2).

## 1. Two namespaces, one email space, no link

| Axis | Tenant identity spine | Talent Portal identity |
|---|---|---|
| Table | `identity."User"` (+ `UserTenantMembership`, roles, `AuthorizationVersion`) | `portal_identity."PortalUser"` |
| Key | `User.email` (global UNIQUE, normalized) | `PortalUser.email_normalized` (UNIQUE) |
| Ownership | exactly ONE tenant per User (`User.tenant_id` NOT NULL, `UNIQUE(UserTenantMembership.user_id)`, composite owner FK, immutability trigger — IC-1) | no tenant; the portal is a talent-axis, passwordless identity |
| Credential | Cognito federated login → RS256 JWT with `consumer_type ∈ {recruiter, ingestion, platform, esign}` | magic-link token → JWT with `consumer_type = portal`, `tenant_id` = platform sentinel |
| Authorization | effective scopes resolved from roles per consumer (PR-6 namespace filter), versioned (`authz_version`) | the FIXED portal scope set (`portalScopes`), version pinned to 1 — roles are never consulted |
| Cross-schema pointer | none to the portal | `cluster_id` → PII-free `identity_index` cluster (UUID ref, NO FK) only |

The same human may exist on both axes under the same email (a recruiter who is also a portal user; from PR-9, a PERSONAL Sign subscriber who is also a portal user). The two rows are unrelated: no foreign key, no shared id, no code path reads one from the other.

## 2. Invariants (each is a test)

1. `PortalUser` carries no `tenant_id`, no `user_id`, no `@relation` — `libs/portal-identity/src/tests/portal-identity-boundary.spec.ts`.
2. The identity schema never mentions `portal_identity`/`PortalUser`; the portal schema never declares identity models — same spec.
3. `libs/identity` never imports `@aramo/portal-identity` and vice versa — same spec (git-grep guard).
4. `portal_identity` has 0 foreign keys; a `PortalUser` with the same normalized email as a tenant `User` coexists and is deleted without touching identity — `libs/identity/src/tests/ic4-pr9-personal-tenant.integration.spec.ts` (#11, real Postgres).
5. A portal credential resolves exactly the fixed portal set regardless of any roles the same-email tenant User holds (no widening through aggregation) — same spec (#12) and `authorization-resolver.consumer-isolation.spec.ts`.
6. Consent and dispute records (`libs/consent`, `libs/talent-trust`) are tenant-scoped rows keyed by `tenant_id` (+ talent record / subject id); no column binds them to an `identity.User` — boundary spec.
7. One User, one tenant: a personal Sign User cannot acquire a business membership; a registered email cannot create a second identity (`EMAIL_UNAVAILABLE`, details `{}`) — PR-9 integration spec (#2, #3), `ic1-cardinality.integration.spec.ts`.

## 3. Personal (B2C) tenancy and the portal

A PERSONAL tenant (`Tenant.kind = 'PERSONAL'`) is an ordinary tenant: one owning User, one membership, `allowed_domain` NULL (P1 Amendment P1-A1), capabilities closed to `[core, esign]`, owner role `org_admin`, Sign sender role a separate governed grant (IC-3 PR-8). It is a product-axis identity. It does not create, read, link or merge a portal identity, and portal sign-in does not create, read, link or merge a tenant identity.

## 4. Future interoperability — what a contract must decide before any code

- Which rail owns the link (`PortalUser ↔ User`): the portal sits on the talent/platform rail; Identity-Rail D1–D3 forbid tenant-side identity crossing.
- Link representation: opaque ref, consent-gated, no PII in `identity_index`.
- Consent boundary: portal consent/notice events remain the person's record on the talent axis; a product session must not inherit or aggregate them.
- Authorization: a linked pair still resolves per consumer (portal fixed set vs tenant roles); linking must not widen either side.
- Lifecycle: RTBF/erasure on one axis must not silently cascade to the other without a ruling.
- Activation: Talent Portal SSO / shared login is out of IC-1..IC-4 scope.

Any such feature changes the specs in §2 under its own authorized directive; until then the specs fail closed.
