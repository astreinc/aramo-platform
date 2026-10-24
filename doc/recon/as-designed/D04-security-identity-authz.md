# D04 — Security: Identity, AuthN/AuthZ, Tenant Isolation & Policy (AS-DESIGNED)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124 · category AS-DESIGNED

AS-DESIGNED intent is cited ONLY from ratified LOCKED directives (canonical
OneDrive `Aramo/locked/`, cited below as `locked/<file>`) and ADRs under
`doc/adr/*`. Where no ratified anchor exists, this is stated explicitly — design
intent is NOT synthesized from code. Where an amendment differs from its parent,
the amendment governs and this is said in place.

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
- **Superseded in part by ADR-0036** (below): the legacy trust substrate,
  including `identity-index`, is retired, and cross-tenant talent evidence moves
  to the Talent Intelligence service under its own database and access model.
  The ADR-0029 `identity_index` boundary therefore has no remaining schema to
  govern at this baseline.

### Talent Intelligence as an independent service (ADR-0036)
- `doc/adr/0036-talent-intelligence-service.md` (Status: Accepted, 2026-10-23;
  governing directive ATI-SEP-1 + Addenda A1/A2). "Supersedes (for Talent
  Intelligence only)" ADR-0029 :63.
- Decision 2: TI holds global, cross-tenant evidence "under a different access
  model (subject-scoped access)" in its own database and role, which "is what
  makes 'ATS cannot read TI storage' structural rather than conventional."
- Decision 3 "Service auth (E-2)" (`:107`): API calls use a **client-credentials
  token exchange** issued by TI; webhooks are HMAC-signed.
- Decision 6 "Access" (`:177`): a tenant reads a subject only with the
  `intelligence` capability **and** an ACTIVE `ExternalTalentReference`;
  "Knowledge of a subject id grants nothing" (`:182`); cross-tenant read is off by
  default pending Legal; a single tenant's erasure never deletes evidence.
- Consequences (`:201`): `talent-trust`, `identity-index`, `platform-trust`,
  `talent-reconcile` are retired in T10; data is not migrated.

### Right-to-be-Forgotten / anonymization (ADR-0007, Decision F)
- `doc/adr/Aramo-ADR-0007-Talent-RTBF-Anonymization-v1_0-LOCKED.md` §"Decision F":
  RTBF is realized as a **talent-module anonymization state machine, not a hard
  delete** — PII-bearing fields anonymized/tombstoned while referential anchors +
  append-only audit/consent history are preserved non-identifiably; an
  `is_anonymized` state flag is the observable marker.
- §"Decision F" (`:18`): "The **build of this state machine is deferred** to a future
  milestone."
- §"Current state": Status is **ACCEPTED (deferred implementation)** (`:3`). The
  TR-15 B2 amendment (`:23`) notes `is_anonymized` now derives from a retained
  `audit."ConsentAuditEvent"` `consent.erased` marker written by the `erase-talent`
  CLI; the anchor still states "A verified deletion request cannot be fully
  honored today" (`:26`).
- **Amended by** `locked/ARAMO-S2-Talent-Erasure-Integrity-Amendment-v1.0-LOCKED.md`
  (ratified 2026-10-16), which governs where it differs:
  - §2: each append-only trigger admits an erasure operation only through
    `consent.s2_erasure_permits`, true only when the transaction-local run setting
    names a `consent."TalentErasureRun"` row **created by this transaction**, the run
    is in its authorizing state, the tenant matches and the row's talent is in the
    run's record set. "A session setting alone never confers privilege."
  - §3.1 DELETE talent-owned immutable content; §3.2 RETAIN workflow history with
    tombstone + redaction (ADR-0007); §3.3 client talent restriction per PO
    direction; §4 commercial and legally retained records remain BLOCKED
    (fail-closed); §6 retained ledger declared minimum; §8 production is separately
    authorized.
- **Further amended for the ATS/TI split** by
  `locked/Aramo-ATS-TI-Separation-Program-Directive-v1_0-Addendum-A1-Erasure-Ruling-LOCKED.md`
  (erasure semantics carried by ADR-0036 Decision 6: `talent.erased` sets the TI
  reference to ERASED; evidence is retained as audit).

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

The following mechanisms are governed by LOCKED directives that live only at the
canonical OneDrive `Aramo/locked/` location (per `CLAUDE.md` / `MEMORY.md`), not
under `doc/adr/`. Where a LOCKED directive ratified on or after 2026-10-09 governs,
its intent is cited below by file and section. Mechanisms whose governing text
predates that window and was not re-read remain listed without reproduced intent.

- **JWT contract & compact-token / `authz_version` design** — code cites "API
  Contracts Phase 1 §1", "PR-8.0b directive §3 Topic 2/3", and "HF-AUTH-1"
  (`libs/auth/src/lib/jwt-auth.guard.ts:62`, `libs/auth-core/src/lib/jwt-issuer.service.ts:13`).
  No `doc/adr/*` anchor; governing text not reproduced here.
- **Scope catalog / RBAC / role bundles (AUTHZ-1/2, PR-A1a Ruling 1–5)** — code
  cites these directives (`libs/identity/src/lib/dto/scope.dto.ts:1`,
  `libs/identity/src/lib/dto/role.dto.ts:1`). Superseded for the role model by
  ROLES-1 / ADR-0035 (below).
- **Site axis (PR-A1a Ruling 5) and "absent site claim = tenant-wide" rule** —
  cited in `libs/authorization/src/lib/roles.guard.ts:25`. No `doc/adr/*` anchor.
- **Auth decoupling / `resolveSession` port (ADR-0021 §2)** — cited in
  `libs/auth-core/src/lib/session-orchestrator.service.ts:221`, but `doc/adr/`
  contains **no `0021-*` file** at this SHA. Its PR-4 amendments are LOCKED (below).
- **Field-masking non-invertible-bundle intent (AUTHZ-D5)** and **visibility
  predicate (AUTHZ-D4a/D4b Amendment v1.1 §4.3)** — cited in
  `libs/field-masking/src/lib/compensation-scope.ts:1` and
  `libs/visibility/src/lib/visibility-resolver.service.ts:22`. No `doc/adr/*`
  anchor.
- **Refresh-token rotation / reuse-detection (R.2 cascade)** and
  **email_verified trusted-federation (§5 Auth-Hardening D2 P1)** — cited in
  `libs/auth-core/src/lib/refresh-orchestrator.service.ts` and
  `cognito-verifier.service.ts`. No `doc/adr/*` anchor.

### One User, one tenant (IC-1)
- `locked/Aramo-D-AUTHZ-PLATFORM-INVITE-1-Amendment-A1-One-User-One-Tenant-v1_0-LOCKED.md`
  §1: "Every authenticated ATS, Sign, or TIP product `identity.User` belongs to
  exactly one owning `identity.Tenant` and has exactly one `UserTenantMembership`
  for that tenant … no User may be linked to another tenant." Later gated
  migrations make `User.tenant_id` non-null, immutable and FK-bound, membership
  `user_id` unique, and add a composite membership-to-User FK. §2 retires the
  cross-tenant `membership_added` branch (`addMembershipForExistingUser`).
- `locked/Aramo-Invite-S2-Flow-Token-State-Directive-Amendment-A1-One-User-One-Tenant-v1_0-LOCKED.md`
  carries the same invariant into the invite flow (title-level; body not re-read).

### Host-bound resolution, refresh eligibility and consumer isolation (Auth-Decoupling PR-4 amendments; IC-2)
- `locked/Aramo-Auth-Decoupling-PR-4-Directive-Amendment-A1-Host-Bound-Resolution-v1_0-LOCKED.md`
  §2 (overrides the parent where they differ): `ResolveSessionResult` is
  `resolved | denied`; a multi-tenant resolution is `denied
  tenant_resolution_ambiguous` and "No tenant chooser is introduced"; the 409
  `TENANT_SELECTION_REQUIRED` callback response is retired (code kept
  COMPATIBILITY_RESERVED); `ResolveSessionInput` gains optional `host_class` /
  `context_id`; binding rules run after tenant selection, before the status gate
  (TENANT host = sealed context; PLATFORM host = platform consumer + sentinel;
  PRODUCT host = dark scaffold; unbound governed by `AUTH_HOST_TENANT_BINDING` and
  `AUTH_ALLOW_UNBOUND_HOST`).
- `locked/Aramo-Auth-Decoupling-PR-1-Directive-Amendment-A1-Host-Binding-Exception-v1_0-LOCKED.md`,
  `...PR-5a-...-A1-...` and `...PR-5b-...-A1-...` §2: the host-binding exception
  clauses those parent directives needed (title/§ level; bodies not re-read).
- `locked/Aramo-Auth-Decoupling-PR-4-Directive-Amendment-A2-Refresh-Eligibility-v1_0-LOCKED.md`
  §2: `ResolveScopesResult` becomes `resolved | denied`; before any re-mint the
  adapter re-proves `User.is_active`, an ACTIVE membership in an ACTIVE stored
  tenant; `User.is_active` is also a login-mint gate; `/refresh`, `/session` and
  `/logout` evaluate the host policy against the token's tenant; a generic
  both-direction tier tripwire in `JwtAuthGuard`; platform-tier role keys are never
  assignable through tenant-side paths.
- `locked/Aramo-Auth-Decoupling-PR-4-Directive-Amendment-A3-Consumer-Isolated-Sessions-and-Return-To-v1_0-LOCKED.md`
  §2: per-consumer session cookies and a validated same-host return-to; the
  status gate stays tenant-consumer-only and `org` is a tenant consumer. (The
  filed text's status line reads "RATIFICATION PENDING"; it is filed under
  `locked/` with the LOCKED suffix.)
- `locked/Aramo-Platform-Console-Increment-2-PR-1-Directive-Amendment-A1-Owner-First-Session-Activation-v1_0-LOCKED.md`
  §2: owner first-session activation runs in `resolveSession` after host binding,
  status, capability and scopes; never on refresh, never for `platform`;
  best-effort, idempotent, never changes the minted session.

### The `org` consumer and product scope isolation (D-ORG, AUTHZ-2 A1)
- `locked/Aramo-D-ORG-Amendment-A1-IC-0-F2-Rules-3-4-Org-Consumer-v1_0-LOCKED.md`
  §1–§2 (extends IC-0 §F.2 rules 3, 4, 7): a sixth consumer `org` maps to the
  `core` capability ("`core` is NOT a product and holding `core` grants no ATS or
  Sign authorization"); the `org` scope filter is `ORG_ADMIN_SCOPE_KEYS ∩ held`;
  cookies stay host-only, no apex cookie; product availability is
  backend-authoritative (`GET /v1/me/products`) and the FE mirrors no entitlement;
  ATS role assignment is entitlement-gated (`ats_role_not_entitled`).
- `locked/Aramo-AUTHZ-2-Platform-Tier-Directive-Amendment-A1-Sixth-Consumer-Org-v1_0-LOCKED.md`
  §2: `CONSUMER_TYPES` gains `org` across `libs/auth`, `auth-core` and
  `openapi/auth.yaml`.
- Both files' status lines read "RATIFICATION PENDING"; both are filed under
  `locked/` with the LOCKED suffix.
- `locked/Aramo-AUTHZ-1b-Catalog-Revision-Directive-Amendment-A1-Org-Admin-Role-v1_0-LOCKED.md`
  §2 introduced `org_admin`; **superseded** by ROLES-1 (next section, Conforming
  Amendment 1).

### Organization and product role model (ADR-0035 / ROLES-1)
- `locked/Aramo-ADR-0035-Organization-and-Product-Role-Model-v1_0-LOCKED.md`
  (Accepted 2026-10-20). §2 R1: `tenant_owner` and `tenant_admin` are
  organization-level roles holding the organization permissions plus the admin
  permissions of every product the tenant holds; both hold `sign:envelope:send`;
  owner-only acts are billing, ownership transfer, the sign-in provider pin and
  closing the organization; `tenant_owner` is the only owner role ("no
  `sign_owner`, no `ats_owner`"); the last holder cannot be removed. R2:
  `ats_admin` / `sign_admin` administer one product and grant no organization
  administration. R3: `tenant_admin`→`ats_admin`, `org_admin`→`tenant_admin`,
  `sign_owner` removed. R4: Personal Sign users and Sign self-service owners get
  `tenant_owner` + `tenant_admin`. R5: session isolation per IC-2 PR-6 stays.
- `locked/Aramo-ROLES-1-Organization-and-Product-Role-Model-Implementation-Directive-v1_0-LOCKED.md`
  (LOCKED 2026-10-21) §3.1 static bundles + existing session filters; §3.3
  partitions in `role.dto.ts`; §3.4 owner-only acts (`PIN_OWNER_ROLE_KEYS`,
  `TENANT_ACTIVATING_OWNER_ROLE_KEYS = ['tenant_owner']`); §4.1 DB last-owner
  triggers with a per-tenant advisory lock, "No bypass parameter exists (safeguard
  S-1)", break-glass only by superuser `ALTER TABLE … DISABLE TRIGGER`; §4.2 "Only a
  caller holding `tenant_owner` may grant or remove `tenant_owner`" (403
  `owner_role_requires_owner`); §10 activation timing.
- `locked/Aramo-ROLES-1-Conforming-Amendments-v1_0-LOCKED.md`: supersedes, without
  editing, the AUTHZ-1b A1 `org_admin` clause and the IC-3 PR-8 "no ATS role holds
  `sign:envelope:send`" rule (organization roles now hold it).
- No in-repo `doc/adr/0035-*` file exists at this SHA.

### Federated sign-in and provider pinning (AUTH-SIGNIN-1; Subdomain-Identity B A2)
- `locked/Aramo-AUTH-SIGNIN-1-Unified-Branded-Sign-In-Directive-v1_0-LOCKED.md`
  §R (binding; overrides §1–§6 where they conflict): R1 backend provider
  enforcement for enforced-pin tenants; R2 "Google and Microsoft identities are
  never linked to one Aramo User automatically on email equality alone … Existing
  links are never re-pointed. Every link is audited with its provider."; R4 a
  `login-options` failure fallback "never weakens backend authorization"; R5 never
  re-enable password auth on the production app client; R6 SSO, PKCE, MFA policy,
  host binding and portal magic-link isolation preserved; R7 the live Cognito
  PreSignUp trigger contradicts R2 and its source is to be brought under version
  control and replaced. §4: host-binding enforce for the PRODUCT host is not
  changed and needs a separate Lead ruling.
- `locked/Aramo-Subdomain-Identity-B-IdP-Routing-Directive-Amendment-A2-Enforced-Provider-Pin-Sign-Signup-Cohort-v1_0-LOCKED.md`
  §2: a tenant is an enforced-pin tenant iff a `TenantIdentityProviderPolicy` row
  exists, written only by Sign self-service signup provisioning; §3: the
  authenticating provider must equal the pin, a null or ambiguous provider is
  refused, the first pin is set once by the pre-provisioned owner via
  compare-and-set, and a non-owner into an unpinned enforced tenant is refused.
  (§3.3 names `org_admin` / `tenant_owner`; ROLES-1 narrows the pin owner to
  `tenant_owner`.)
- `locked/Aramo-Subdomain-Identity-B-IdP-Routing-Directive-Amendment-A1-Host-Bound-Callback-v1_0-LOCKED.md`:
  host-bound callback (title-level; body not re-read).

### Tenant kind, domain lock and one organization per domain
- `locked/Aramo-Domain-Enforcement-P1-Directive-Amendment-A1-Personal-Tenant-Exception-v1_0-LOCKED.md`
  §2: `Tenant.kind` BUSINESS (default) | PERSONAL as a string vocabulary; a
  PERSONAL tenant has `allowed_domain = NULL` and capabilities closed to
  `[core, esign]` (renamed `sign` by
  `locked/Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED.md`, which governs the
  identifier); BUSINESS paths unchanged.
- `locked/Aramo-Domain-Enforcement-P3-One-Organization-Per-Domain-Directive-v1_0-LOCKED.md`
  §1: "at most one **domain-holding** BUSINESS tenant per email domain"; a further
  tenant may share a domain only through an audited platform-operator exception;
  identity verification, ownership attestation, domain verification and product
  entitlement are separate checks and "None substitutes for another." §3:
  enforcement at `TenantService.provisionTenant` (authoritative), the platform
  console, and Sign signup `start`/`complete` (non-enumerating), error
  `TENANT_DOMAIN_UNAVAILABLE` 409 `organization_domain_taken`. §5: IT-admin
  delegation; §6: operator actions under `platform:tenant:lifecycle:manage`.

### Sign signup, Personal (Free) signup and abuse controls
- `locked/Aramo-Sign-Signup-Federated-Owner-Directive-v1_2-LOCKED.md` §3 behaviour,
  §4 conditions before public signup, §6 release restrictions;
  `locked/Aramo-Sign-Signup-Federated-Owner-Directive-Amendment-A1-Organization-Details-US-Only-v1_0-LOCKED.md`
  adds organization details / US-only (title-level). ADR-0035 R4 amends the owner
  roles to `tenant_owner` + `tenant_admin`.
- `locked/Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED.md`: §6.1
  Cloudflare Turnstile verified server-side on `start`, plus honeypot and minimum
  completion time; §6.2 rules-based, explainable risk points with thresholds
  `< 30 allow`, `30–59 step_up`, `60–89 review`, `≥ 90 refuse`, and send-time checks
  for young accounts; §6.3 phone verification; §6.4 abuse reports; §6.5 operator
  controls and appeal; §6.6 geographic eligibility; §12 ships with mode `off`, and
  `invite` / `open`, provider accounts and legal publication are separately
  authorized.
- `locked/Aramo-Sign-Personal-Free-Launch-Directive-v1_1-Amendment-A1-v1_0-LOCKED.md`
  (LOCKED 2026-10-22; governs where it differs): A1-1 geographic eligibility,
  A1-2 phone step while SMS is unavailable, A1-3 retention, A1-6 SMS on hold,
  A1-9 closed accounts.

### Sign sender authorization (Sign Unified Product)
- `locked/Aramo-Sign-Unified-Product-Permission-Contract-Platform-API-Directive-v1_0-LOCKED.md`
  §4.3: "Every Sign API call — from the Sign app, from ATS, or from an approved
  third-party platform — is checked server-side"; §4.3.2 maps account → tenant
  holding the Sign capability (BUSINESS or PERSONAL), user → one-tenant Aramo user.
  §6 prohibitions; §9 release restrictions.

### Talent Portal identity (ATI-SEP-1 A4)
- `locked/Aramo-ATS-TI-Separation-Program-Directive-v1_0-Addendum-A4-Portal-Identity-Deferral-LOCKED.md`
  (PO ruling 2026-10-23): "Let's not worry about portal login. We will revisit."
  Binding interpretation: T10 retires `identity_index`, trust clusters and portal
  `cluster_id` resolution; portal login may stop working until the Portal identity
  increment; portal endpoints that cannot resolve a Talent return a uniform
  non-leaking "not available"; no destructive migration of `portal_identity`;
  recruiter/admin login is unaffected.

### Talent Trust tenant isolation (S1)
- `locked/Aramo-Security-S1-Talent-Trust-Tenant-Isolation-Remediation-Directive-v1_0-LOCKED.md`
  §3 R1 "Tenant authorization is mandatory inside Talent Trust", R2 tenant-keyed
  atomic lifecycle writes, R4 concealment. (The filed text's status line reads
  "DRAFT / NOT EFFECTIVE"; it is filed under `locked/` with the LOCKED suffix.) Its
  subject, `libs/talent-trust`, is retired by ADR-0036 / ATI-SEP-1 T10, so the
  directive has no live code surface at this baseline.

## Empty / absent anchors (explicit)

- There is **no dedicated AuthN/AuthZ ADR** under `doc/adr/` at this SHA (no
  `0021` auth-decoupling file, no `0035` role-model file, no identity/JWT/RBAC
  ADR). The security domain's governing specifications are predominantly off-repo
  LOCKED directives.
- ADR-0007 anchors **only Decision F**; its other lettered decisions are stated to
  predate the current corpus and are not reproduced
  (`doc/adr/Aramo-ADR-0007-Talent-RTBF-Anonymization-v1_0-LOCKED.md:8`).
- IC-0 (`ARAMO-IC-0-Identity-Cardinality-Gate-0-Report-v1_0.md`, the parent of the
  D-ORG A1 amendment) is not filed with a LOCKED suffix in `locked/`; its rules are
  cited here only as reproduced by the LOCKED amendments.
- DRAFT predecessors in `Aramo/documents/` (not ratified, not cited as intent; each
  is superseded by the LOCKED file of the same name cited above):
  `Aramo-AUTH-SIGNIN-1-…-v1_0-DRAFT.md`, `Aramo-Domain-Enforcement-P3-…-v1_0-DRAFT.md`,
  `Aramo-ROLES-1-…-Implementation-Directive-v1_0-DRAFT.md`,
  `Aramo-ROLES-1-Conforming-Amendments-v1_0-DRAFT.md`,
  `Aramo-Sign-Personal-Free-Launch-Directive-v1_0-DRAFT.md`,
  `Aramo-Sign-Personal-Free-Launch-Directive-v1_1-Amendment-A1-DRAFT.md`,
  `Aramo-ORG-UX-1-…-v1_0-DRAFT.md`. `Aramo-Sign-Personal-Terms-of-Service-v0_2-DRAFT.md`
  is a legal draft with no ratified counterpart. The LOCKED ORG-UX-1 directive
  (`locked/Aramo-ORG-UX-1-App-Home-and-Organization-Redesign-Implementation-Directive-v1_0-LOCKED.md`)
  is owned by D13 and was not re-read here.
