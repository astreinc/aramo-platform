# D04 — Security: Identity, AuthN/AuthZ, Tenant Isolation & Policy (AS-DESIGNED)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212 · category AS-DESIGNED

AS-DESIGNED intent is cited ONLY from ratified LOCKED directives / ADRs under
`doc/adr/*`. Where no in-repo ratified anchor exists, this is stated explicitly —
design intent is NOT synthesized from code.

## Anchored design intent (ratified ADRs in `doc/adr/`)

### Tenant isolation & hard invariants (ADR-0024, D3)
- `doc/adr/0024-business-policy-engine.md` §D3 enumerates the platform's **hard
  invariants** that are enforced at compile time / CI walls / schema boundaries and
  are explicitly **outside** any runtime engine: "no government identifier in the
  cross-tenant index, no auto-merge without a Tier-A anchor, dormant-until-consented,
  no [R10 match term] on a person, tenant isolation, prohibited vocabulary."
- §D3 ruling: "The policy engine has no vocabulary for invariants. It cannot
  express them, therefore it cannot relax them. Making an invariant
  policy-configurable requires a superseding ADR, never a rule row."

### Business Policy Engine as data (ADR-0024, D2/D4/D5)
- `doc/adr/0024-business-policy-engine.md` §D2: policies are **DATA, not code** —
  rows `(resource, action, resource_state, decision, reason_codes, effect_set)`,
  versioned/published; a tenant needing different rules is a data operation, never
  a deploy.
- §D4: the engine is **domain-agnostic** — `(resource, action, context) → decision`
  — and knows nothing of requisitions/talent/recruiting; Lifecycle is its first
  registered package.
- §D5: resource + action, never domain-named operations.
- Governing precedence: §Precedence states ADR-0024 is governed by **ADR-0020
  (Build For Tenant #50)**, which wins on any scoping conflict.

### Cross-tenant identity keyspace boundary (ADR-0029, I1/I14/I15)
- `doc/adr/Aramo-ADR-0029-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md`
  "Relationship to other ADRs": invariants **I1 / I14** are "consistent (UUID-only
  cross-schema; `identity_index` PII/tenant boundary). No invariant relaxed." This
  anchors the design intent that `identity_index` carries **no PII and no
  tenant_id** and that cross-schema references are UUID-only.
- The ADR enforces **I15** (Pipeline⊥ATS import wall) via nx boundary tags +
  negative-control specs.

### Right-to-be-Forgotten / anonymization (ADR-0007, Decision F)
- `doc/adr/Aramo-ADR-0007-Talent-RTBF-Anonymization-v1_0-LOCKED.md` §"Decision F":
  RTBF is realized as a **talent-module anonymization state machine, not a hard
  delete** — PII-bearing fields anonymized/tombstoned while referential anchors +
  append-only audit/consent history are preserved non-identifiably; an
  `is_anonymized` state flag is the observable marker.
- §"Decision F": "The **build of this state machine is deferred** to a future
  milestone. At ratification time only the design intent and the `is_anonymized`
  placeholder were established."
- §"Current state": Status is **ACCEPTED (deferred implementation)**. The TR-15 B2
  amendment notes `is_anonymized` now derives from a retained
  `audit."ConsentAuditEvent"` `consent.erased` marker written by the `erase-talent`
  CLI; the Decision-F anonymization state machine itself **remains deferred**, and
  "A verified deletion request cannot be fully honored today."

### Consent contract & audit semantics (ADR-0005 / ADR-0006 / ADR-0007 read-endpoint)
- `doc/adr/0005-consent-revoke-contract-and-audit-semantics.md`,
  `doc/adr/0006-consent-check-contract-and-resolver-path-conventions.md`, and
  `doc/adr/0007-consent-state-read-endpoint-and-read-endpoint-conventions.md`
  (in-tree ADRs 0005–0009) ratify the consent revoke/check/state contract and the
  decision-log read-endpoint conventions the `libs/consent` surface implements.
  (NOTE: in-tree ADR number 0007 is the *consent-state read-endpoint* ADR; the
  *RTBF* Decision F is the LOCKED `Aramo-ADR-0007-...` file — two distinct 0007
  artifacts co-exist in `doc/adr/`.)

### Governing principle (ADR-0020)
- `doc/adr/0020-build-for-tenant-50-governing-principle.md` is the governing
  principle cited by ADR-0024 Precedence: foundational security controls are built
  in the controlled single-tenant window; specific-client-tier controls defer
  against a named trigger.

## Design intent NOT anchored in-repo (LOCKED directives are off-repo)

The following AS-BUILT security mechanisms cite their governing LOCKED directives
**in code comments**, but the ratified directive text lives at the canonical
OneDrive `Aramo/locked/` location (per `CLAUDE.md` / `MEMORY.md`), **NOT** under
`doc/adr/`. No in-repo ratified anchor exists for them, so their AS-DESIGNED intent
is NOT reproduced here (per the recon rule against synthesizing AS-DESIGNED from
code):

- **JWT contract & compact-token / `authz_version` design** — code cites "API
  Contracts Phase 1 §1", "PR-8.0b directive §3 Topic 2/3", and "HF-AUTH-1"
  (`libs/auth/src/lib/jwt-auth.guard.ts:44`, `libs/auth-core/src/lib/jwt-issuer.service.ts:13`).
  No `doc/adr/*` anchor.
- **Scope catalog / RBAC / role bundles (AUTHZ-1/2, PR-A1a Ruling 1–5)** — code
  cites these directives (`libs/identity/src/lib/dto/scope.dto.ts:1`,
  `role.dto.ts`). No `doc/adr/*` anchor.
- **Site axis (PR-A1a Ruling 5) and "absent site claim = tenant-wide" rule** —
  cited in `libs/authorization/src/lib/roles.guard.ts:25`. No `doc/adr/*` anchor.
- **Auth decoupling / `resolveSession` port (ADR-0021 §2)** — cited in
  `libs/auth-core/src/lib/session-orchestrator.service.ts:182`, but `doc/adr/`
  contains **no `0021-*` file** at this SHA (verified absent). No in-repo anchor.
- **Field-masking non-invertible-bundle intent (AUTHZ-D5)** and **visibility
  predicate (AUTHZ-D4a/D4b Amendment v1.1 §4.3)** — cited in
  `libs/field-masking/src/lib/compensation-scope.ts:1` and
  `libs/visibility/src/lib/visibility-resolver.service.ts:22`. No `doc/adr/*`
  anchor.
- **Refresh-token rotation / reuse-detection (R.2 cascade)** and
  **email_verified trusted-federation (§5 Auth-Hardening D2 P1)** — cited in
  `libs/auth-core/src/lib/refresh-orchestrator.service.ts` and
  `cognito-verifier.service.ts`. No `doc/adr/*` anchor.

## Empty / absent anchors (explicit)

- There is **no dedicated AuthN/AuthZ ADR** under `doc/adr/` at this SHA (no
  `0021` auth-decoupling file, no identity/JWT/RBAC ADR). The security domain's
  governing specifications are predominantly off-repo LOCKED directives.
- ADR-0007 anchors **only Decision F**; its other lettered decisions are stated to
  predate the current corpus and are not reproduced
  (`doc/adr/Aramo-ADR-0007-...:8`).
