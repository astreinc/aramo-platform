# Aramo — E-Sign Product Experience V1 (Two-Frontend + Standalone Account Model) Backlog Directive v1.0

**Directive ID:** `Aramo-E-Sign-Product-Experience-V1-Backlog-Directive-v1_0`
**State:** BACKLOG — DO NOT BUILD UNTIL ACTIVATED BY PO
**Nature:** Product-experience / frontend productization scope — the two product surfaces plus the standalone E-Sign account, sender-role, and signer-identity model (consolidated; supersedes the interim Amendment v1.1 draft, whose content is folded in here)
**Scope:** Turning the proven E-Sign signing *engine* into the independent E-Sign *product* — a signer experience, a sender/authoring experience, and the standalone account/identity model that lets a non-ATS party subscribe to E-Sign alone
**Applies to:** `apps/sign-web`, a future E-Sign sender/authoring surface (`esign.aramo.ai` or an E-Sign console in the appropriate Aramo admin shell), `apps/esign-service`, `libs/esign`, the `SignatureProviderPort` contract, and the Aramo Core/ATS consumers of the platform
**Parent directives:** `Aramo-E-Sign-Independent-Digital-Signature-Platform-Directive-v1_0` (architecture intent) and `Aramo-E-Sign-Dedicated-Prod-and-Subscription-Backlog-Directive-v1_0` (deployment/commercialization backlog)
**Depends on:** proven end-to-end signing/write-back path (Operational Closure — MERGED) and the retained Sign Web signer foundation
**Authority boundary:** this directive scopes and separates the work and ratifies the product *model and intent*. It does **not** authorize immediate build of any surface, nor of signup, billing, entitlement enforcement, organization CRUD, or an identity-assurance engine. The PO activates it, and a fresh implementation directive is issued against then-current `origin/main`. Subscription/entitlement/billing implementation remains governed by the Dedicated-Prod + Subscription backlog directive.
**Canonical filing target:** Aramo canonical `locked/` location using the `-LOCKED` filename convention
**Repo visibility target:** `doc/backlog/`

---

## 1. Intent — the distinction that matters

The signing *engine* is proven. The signing *product* is not yet built.

A DocuSign-like platform has **two** frontends, not one:

```text
                       ARAMO E-SIGN PLATFORM

  Sender / Authoring side                    Signer side
  ───────────────────────                    ───────────────
  Upload / select document                   Open secure link
  Choose signer(s)                           Review document
  Place fields                               Accept disclosure
  Send envelope                              Fill / sign fields
  Track status                               Complete
  View executed copy                         Receipt
  Manage templates
            │                                       │
            └──────────────►  E-Sign  ◄─────────────┘
```

Today Aramo has **much more of the right-hand (signer) side than the left-hand (sender/authoring) side.**

`sign.aramo.ai` (`apps/sign-web`) is already the **signer** application. Aramo E-Sign does **not yet** have the **sender/authoring** application, nor the standalone **account/subscription** model that would let a non-ATS party use it. Those absences — not a set of cosmetic gaps in Sign Web alone — are the real distance between "a working signing engine" and "the independent E-Sign product."

This directive captures that distance as **two scoped product surfaces plus a standalone account/identity model**, not as a loose list of Sign Web fidelity fixes.

---

## 2. Can Sign Web run standalone? — the correct answer

**Can the signer FE run independently?** Yes. `apps/sign-web` is an isolated SPA (`scope:sign`) and boots on its own origin (locally `localhost:4204`, in production `sign.aramo.ai`).

**Can you open it and sign an arbitrary document?** No — and that is *correct* architecture.

Opening the bare origin does not give a "choose a PDF and sign it" experience. The signer app expects a capability-bearing link:

```text
https://sign.aramo.ai/s/<secure-signing-token>
```

That token exists only after E-Sign has already:

```text
create envelope
  -> attach / freeze document
  -> define signer
  -> send envelope
  -> issue signing capability
```

The signer site must **not** become an upload/authoring application. Originating an envelope is an authenticated *sender* act; signing is a *capability-authenticated* act. Those are two different trust contexts and must not be collapsed into one surface (see §7).

---

## 3. Precise current status — do not overstate readiness

State the platform honestly. The backend evidence chain working does **not** make the current UI production-grade for signing, because the document-review experience is missing.

```text
E-Sign platform backend             PRODUCTION-GRADE SUBSTRATE
Independent service boundary        IMPLEMENTED
Async completion backbone           IMPLEMENTED
Signer capability / security        IMPLEMENTED
Sign Web workflow                   FUNCTIONALLY IMPLEMENTED
Signer product UX                   INCOMPLETE
General sender / authoring UI       NOT BUILT
Standalone account / subscription   NOT BUILT
```

The overall platform path is proven end-to-end:

```text
signing
  -> E-Sign completed
  -> generic signed event
  -> Core
  -> Document EXECUTED
```

That proof is real and must be preserved. It is a substrate milestone, **not** a product-completeness claim.

---

## 4. Foundational rulings

**R-1 — Do NOT rebuild Sign Web from scratch.** The current `apps/sign-web` is a real functional foundation, not a throwaway prototype. The implemented flow is valuable and retained:

```text
secure token
  -> exchange
  -> disclosure
  -> signature capture (typed / drawn)
  -> field completion
  -> completion
  -> execution evidence
```

Rebuilding from zero would discard working substrate. What Sign Web needs is **productization / UX completion**, layered onto the existing flow.

**R-2 — The largest missing signer feature is the document viewer, and it is not cosmetic.** A signer experience should present the actual document being signed, with fields rendered in their true positions:

```text
┌─────────────────────────────────────────────────────┐
│ Offer Letter                               Page 1/3  │
├─────────────────────────────────────────────────────┤
│                                                      │
│                Actual PDF document                   │
│                                                      │
│           [ Sign here __________________ ]           │
│                                                      │
├─────────────────────────────────────────────────────┤
│                            Continue / Finish signing │
└─────────────────────────────────────────────────────┘
```

rather than the current mechanics-only surface:

```text
Please sign
Field id:   [________]
Signature:  [________]
Complete
```

The latter proves the mechanics; it is not the product experience. The document viewer is the single most significant item in Signer Experience V1.

**R-3 — Do NOT add authoring/upload controls to Sign Web.** "Sign any document" must never be solved by bolting upload controls onto the signer site. That would mix two trust contexts (see §7). The sender capability belongs in a separate authenticated surface.

**R-4 — This directive supersedes the earlier "five Sign Web fidelity gaps" framing.** Those five gaps mostly describe Sign Web only. The independent-platform vision requires a second surface and a standalone account model too. The backlog is therefore captured as **Signer Experience V1 + Sender/Authoring Experience V1 + the standalone account/identity model**, not as a single FE cleanup.

---

## 5. Product surface 1 — Signer Experience V1 (`sign.aramo.ai`)

Build on the existing `apps/sign-web`. Roughly, in order:

```text
Document / PDF viewer
      ↓
fields rendered in their actual positions
      ↓
typed / drawn signature
      ↓
initials / date / text fields as required
      ↓
real disclosure (actual disclosure text, not a placeholder hash)
      ↓
completion
      ↓
receipt / executed-document access
```

Then the production-readiness concerns:

- proper Aramo E-Sign branding
- responsive / mobile signer UX
- accessibility
- explicit error states
- expired / consumed / revoked link handling

Ownership: this is **E-Sign public signer work** (`scope:sign`). It talks only to the E-Sign signing API. It must not acquire an ATS account, a recruiter session, direct ATS API access, or tenant authority from browser input (parent directive §18).

---

## 6. Product surface 2 — E-Sign Sender / Administration Experience (`esign.aramo.ai`)

This is **not** Sign Web and must **not** be jammed into it. It is a distinct authenticated surface, conceptually at:

```text
esign.aramo.ai
```

or an E-Sign console within the appropriate Aramo admin shell.

It lets an **authorized sender**:

```text
New envelope
  ↓
Upload PDF
  ↓
Add recipient
  ↓
Place signature fields
  ↓
Preview
  ↓
Send
  ↓
Track status
  ↓
View / download execution evidence
```

Illustrative sender surface:

```text
E-Sign Console

+ New envelope

Document
[ Upload Agreement.pdf ]

Recipients
1. John Smith
   john@example.com

Fields
[ Signature ]  [ Date Signed ]

[ Send for signature ]
```

On send, E-Sign issues the capability and delivers:

```text
https://sign.aramo.ai/s/<capability>
```

and the signer uses the existing Sign Web.

This surface is what turns the original question — *"Can I independently use Aramo E-Sign to sign any document?"* — into **yes** from a product-user perspective.

Ownership: this is **E-Sign platform / product work**, driven by the authenticated command API (`POST /v1/esign/envelopes`, `/:id/send`, etc.) already present. It is a consumer of the platform command contract, exactly as ATS is.

---

## 7. Trust-context separation — the hard architecture rule

"Sign arbitrary documents" is solved by building the sender surface, **never** by adding upload controls to the signer surface. The two live in different trust contexts and must stay separate:

```text
Authenticated sender
        │
        ▼
E-Sign Console / API
        │
        ▼
Envelope
        │
        ▼
E-Sign issues secure capability
        │
        ▼
Capability-authenticated (unauthenticated-session) signer
        │
        ▼
sign.aramo.ai
```

This is the same separation expected of DocuSign, and it fits the ratified Independent-Digital-Signature-Platform directive exactly. Mixing the two contexts into one surface is a boundary violation and is prohibited.

---

## 8. Reserved product URL model

Reserve the following shape conceptually now. Only the signer origin is part of the implemented substrate today; the rest is backlog/future work and must not be claimed as existing.

```text
www.aramo.ai
    Product / company site

esign.aramo.ai
    Authenticated E-Sign sender / account console        (BACKLOG — not built)

sign.aramo.ai
    Public / capability-authenticated signer experience  (EXISTS — apps/sign-web)

api.esign.aramo.ai
    Potential future public E-Sign API                   (OUT OF SCOPE for V1)
```

`esign.aramo.ai` is the **intended** sender-console origin — a reserved product URL, not a live surface. Actual DNS/ingress/hosting ownership for it is governed by the Dedicated-Prod backlog directive, not improvised here.

---

## 9. Standalone (non-ATS) E-Sign account model

**A party that is NOT an Aramo ATS tenant can subscribe to Aramo E-Sign alone.** Independent subscription is a first-class product outcome, not an afterthought of the ATS.

```text
                    ARAMO PLATFORM

                ┌───────────────┐
                │ Identity/Auth │
                └───────┬───────┘
                        │
        ┌───────────────┼────────────────┐
        │                                │
        ▼                                ▼
   Aramo ATS                       Aramo E-Sign
   ats.aramo.ai                    esign.aramo.ai
                                         │
                                         ▼
                                   sign.aramo.ai

Subscribe to one, the other, or eventually both.
```

The entitlement model is per-product on a shared identity:

```text
Aramo Account
      │
      ├── ATS entitlement          (optional)
      ├── E-Sign entitlement       (independent)
      └── other future products
```

Illustrative:

```text
Company A
  ├─ ATS:    NO
  └─ E-Sign: YES
```

Company A still has its own E-Sign organization/account, users, documents, envelopes, and signing history. **This is exactly why the sender console must not live only inside ATS.**

Ratified intent:
1. E-Sign subscription is independent of ATS subscription.
2. A standalone E-Sign subscriber owns an E-Sign organization with its own users, documents, envelopes, and signing history.
3. Identity/Auth is shared across products; product access is gated by per-product entitlement, not by mere existence of an Aramo login.

Deferred (implementation, per Dedicated-Prod + Subscription backlog): signup flow, organization creation/CRUD, plan/pricing, billing, and entitlement *enforcement*. This directive defines the model; it does not build it.

---

## 10. Sender roles and the "who can send" rule

**Do not adopt the rule "anyone with any Aramo account can send documents."**

The correct rule:

> Anyone with an **active E-Sign account / organization membership** and the **appropriate sender entitlement/permission** can send documents.

Intended E-Sign organization roles:

```text
Owner
Admin
Sender
Viewer / Auditor
```

A user with E-Sign **sender** permission may:

```text
Upload
Create envelope
Add recipient
Place fields
Send
Void
Track
Download executed document
```

A user who merely holds an unrelated Aramo login receives **none** of these privileges automatically. Sender capability derives from E-Sign entitlement + org role, never from generic platform authentication.

Deferred (implementation): the exact role catalog, permission matrix, org-membership model, and enforcement. The role *names and intent* above are ratified as the target; a fresh directive ratifies the precise permission matrix before build.

---

## 11. The signer needs no account

Core signing must work with only the secure capability link:

```text
Email
  ↓
https://sign.aramo.ai/s/<secure-capability>
  ↓
review
  ↓
sign
  ↓
complete
```

The signer must **not** be forced to create an account, log in, remember a password, or join an organization merely to sign. This is one of the platform's most important design principles and is non-negotiable for the normal signing path.

---

## 12. Signer-with-existing-account behavior — capability is the authority

An E-Sign account for a signer is **optional convenience, never the authority to sign the envelope.** The secure signing link identifies the signing transaction.

Example — signer already has an account:

```text
Sarah already logged in
        ↓
opens secure signing link
        ↓
E-Sign recognizes the account
        ↓
STILL validates the envelope capability
        ↓
signs
```

The capability determines the authoritative facts:

```text
Envelope:        E-9384
Recipient:       Sarah
Allowed action:  Sign
Document:        Contract.pdf
```

A logged-in account may **improve** the experience but must never **replace** that signing authority.

Optional, layered post-completion account features (product features on top, never prerequisites):

```text
My signed documents
Signing history
Download executed copies
Notifications
Saved signature preference
Profile
```

Ratified rule:

> **The signing link remains the authority for that particular envelope. An account is layered convenience on top of the capability, never a substitute for it.**

---

## 13. Account-mismatch — an explicit security case

The envelope was sent to `john@example.com`, but the browser is currently signed in as `mary@example.com`.

**We must not silently let Mary sign John's envelope merely because she holds the secure link.**

Intended handling (surfaced, not silent):

```text
This document was sent to john@example.com.

You are currently signed in as mary@example.com.

[ Continue using signing link ]
        or
[ Sign out / switch account ]
```

Depending on the identity-assurance rules, E-Sign may require verification of the intended recipient before allowing the signature. That identity-assurance policy is to be **designed deliberately in a later directive**; the current capability model already provides the correct foundation for it (the capability, not the session, is authoritative). This case MUST be handled explicitly by the eventual identity policy — never resolved by defaulting to "logged-in session wins."

---

## 14. Three distinct roles + the signer→sender graduation path

Keep three concepts separate:

```text
1. E-Sign subscriber / organization   e.g. Astre Consulting — holds the E-Sign subscription
2. Sender                             e.g. Purush — logs into esign.aramo.ai, creates/sends envelopes
3. Signer                             e.g. John Smith — receives sign.aramo.ai/s/... ; account OPTIONAL
```

```text
Organization
      │
      └── Sender account
              │
              │ sends
              ▼
           Envelope
              │
              ▼
            Signer
       (account optional)
```

**Graduation path** — an external signer can later become a sender without changing the platform:

```text
John signs today with no account
  ↓
later creates an Aramo account
  ↓
subscribes to E-Sign
  ↓
creates an organization
  ↓
becomes a sender
```

His role changes from *external signer* to *E-Sign account holder / sender* on the same underlying signing platform. A unified Aramo identity system makes this graduation clean.

---

## 15. E-Sign Product Experience V1 — the tightly scoped increment

Do not attempt every DocuSign feature at once. When activated, cut **one** tightly scoped increment.

**V1 goal (verbatim intent):**

> An authorized user can upload a PDF, identify one signer, place required signature/date fields visually, send it, and the recipient can review the actual document and sign it through `sign.aramo.ai`.

End-to-end V1 path:

```text
Upload
  → configure (one signer, signature + date fields, placed visually)
  → send
  → recipient receives email
  → recipient reviews the actual PDF
  → recipient signs
  → executed PDF
  → certificate
```

V1 deliberately fixes the scope to: single signer, minimal field set (signature + date, extendable to initials/date/text as R-2/§5 allow), visual placement, real document review. It is the smallest increment that yields a genuine independent product rather than a mechanics demo.

---

## 16. Target standalone product scenario (the ratified end state)

The scenario for a party who is not an Aramo ATS tenant but wants Aramo's digital-signature product:

```text
Go to esign.aramo.ai
        ↓
Sign up / subscribe (E-Sign only)
        ↓
Create E-Sign organization
        ↓
Upload document
        ↓
Add signer email
        ↓
Place signature / date fields
        ↓
Send
        ↓
Signer gets email
        ↓
Signer clicks sign.aramo.ai/s/<capability>   (no account required)
        ↓
Signer reviews the actual PDF and signs
        ↓
Sender receives completed document + certificate
```

This is consistent with the V1 goal (§15). The standalone account/identity model (§§9–14) is what makes "standalone E-Sign subscriber" a defined product outcome rather than a future guess.

---

## 17. ATS becomes merely another client

Once the product surfaces exist, ATS is one consumer among others, not a privileged private E-Sign experience:

```text
ATS RTR
ATS Offer
      │
      ▼
same E-Sign platform
```

There must not be a special "ATS-only" E-Sign product experience diverging from the general platform. RTR and Offer flows drive the **same** command API and consume the **same** generic lifecycle events as any other sender.

---

## 18. Relationship to the parent directives

This backlog directive is subordinate to, and must remain consistent with:

1. **Independent-Digital-Signature-Platform Directive v1.0** — the boundary rules (E-Sign owns signer delivery, capability material, execution, durable generic events, retry; consumers own business interpretation; no cross-schema access; Sign Web is E-Sign-owned and ATS-auth-free). Both product surfaces and the account model here are constrained by that directive. In particular the sender surface is a *command-API consumer*; it does not become a second authority over envelope/signature state.
2. **Dedicated-Prod + Subscription Backlog Directive v1.0** — deployment/commercialization. Ingress/hosting for `esign.aramo.ai` and `sign.aramo.ai`, plus subscription/entitlement/billing implementation, are governed there, not improvised here.

If any V1 implementation choice conflicts with either parent, HALT and surface to the PO rather than normalizing the architecture around the FE/account task.

---

## 19. Hard invariants

When this directive is implemented:

1. The signer surface (`sign.aramo.ai`) never gains document-authoring or upload capability.
2. The sender surface is an **authenticated** surface; the signer surface is **capability-authenticated** only. The two trust contexts are never merged.
3. The sender surface consumes the E-Sign command API; it does not reach into E-Sign persistence or reproduce E-Sign's state machine as a second authority.
4. Raw signing capability material stays inside E-Sign; the sender surface never receives a raw signing token merely to relay it.
5. Sign Web remains `scope:sign` — no ATS/Documents/Portal imports, no ATS account, no tenant authority from browser input.
6. The document viewer renders the frozen, authoritative document supplied by the platform; the signer UI never becomes the source of document truth.
7. ATS is treated as one client of the platform, with no ATS-only E-Sign product fork.
8. E-Sign subscription and sender capability are independent of any ATS subscription.
9. Send authority requires E-Sign entitlement + an org role that grants it — never mere Aramo authentication.
10. The signer's core flow never requires an account; the capability link alone is sufficient.
11. When a signer account exists, the capability — not the logged-in session — remains the signing authority for that envelope.
12. Account mismatch (session email ≠ intended recipient) must be surfaced explicitly and handled by a deliberate identity-assurance policy; it must never be silently resolved in favor of the logged-in session.
13. The sender console is a shared-identity, entitlement-gated product surface; it does not live only inside ATS.
14. No V1 work reopens Core Documents ownership, Offer acceptance policy, or the Documents contract boundary.

---

## 20. Explicitly out of scope for V1 (until separately authorized)

- multi-signer envelopes and signing order/routing
- organization / counterparty (non-individual) signing
- template creation and management
- reminders, expiry policy configuration, bulk send
- advanced field types beyond signature / date / initials / text
- external (non-Aramo) E-Sign API product, SDKs, developer portal
- billing, pricing, subscription tiers, metering, entitlement *enforcement* (see Dedicated-Prod backlog)
- external provider integrations (DocuSign / Adobe) and multi-provider tenant settings
- dedicated-database or dedicated-box cutover
- WORM / legal-hold, retention products, tenant-managed storage
- Model-C multi-condition Offer acceptance or any workflow-engine introduction

---

## 21. Still deferred after this directive

This directive defines the model and scopes the surfaces. The following remain **implementation** work, each requiring its own activation + directive:

- signup / subscription / billing / plan definition (Dedicated-Prod + Subscription backlog)
- entitlement **enforcement** and organization CRUD
- the precise sender role/permission matrix
- the signer identity-assurance policy (login-recognition rules, mismatch verification thresholds)
- signer account-convenience features (history, saved signature, notifications, profile)
- `esign.aramo.ai` DNS / ingress / hosting (Dedicated-Prod backlog)
- public third-party E-Sign API / SDK / developer portal (explicitly OUT of V1)

---

## 22. Activation preconditions + recon

Do not start until the PO explicitly activates this item and the following are re-confirmed against current `origin/main`:

1. `apps/sign-web` remains the retained signer foundation and boots independently.
2. The E-Sign command API (`create` / `send` / `query` / `evidence` / `executed` / `void`) remains intact and contract-based.
3. The generic completion event + consumer write-back path remains operational (Operational Closure retained).
4. `sign.aramo.ai` remains the intended signer origin; no sender surface has been improvised inside Sign Web.

On activation, the first step is READ-ONLY recon reporting:

1. current `apps/sign-web` stage/flow inventory and where the document viewer would mount
2. current signing API surface consumed by the signer flow
3. current command API surface a sender surface would consume (envelope create/upload/field-placement/send/track/evidence)
4. current document freeze/attach mechanics and how field coordinates would be stored/resolved
5. current auth/identity model available for an authenticated sender surface and a shared-identity per-product entitlement
6. current ingress/hosting posture for a second (`esign.aramo.ai`) origin
7. any existing admin-shell surface a console could nest into
8. current organization/membership primitives (if any) that a standalone E-Sign account would build on

Then issue a fresh V1 implementation directive against that substrate. Do not build from this backlog text alone.

---

## 23. Completion definition for V1

V1 is complete only when proven, not merely configured:

- An authorized sender uploads a PDF, adds one signer, and places signature + date fields visually through the sender surface.
- The sender surface sends the envelope via the E-Sign command API and can track its status.
- The signer receives the delivery, opens `sign.aramo.ai/s/<token>`, and **reviews the actual document** in a viewer with fields in their true positions.
- The signer applies a typed/drawn signature and date, and completes — without being forced to create an account.
- E-Sign produces the executed PDF + execution certificate.
- The generic completion event flows to consumers, and (for ATS) Core Documents reaches EXECUTED, with local workflow re-evaluating — unchanged from the proven path.
- No trust-context mixing occurred: the signer surface never exposed authoring; no raw signing token left E-Sign; send authority came from E-Sign entitlement + role, not a bare Aramo login.

Only then is Aramo E-Sign an *independent product*, not merely an independent *engine*.

---

## 24. Standing instruction to future Claude Code sessions

If a future task touches the E-Sign signer or sender frontends, or the E-Sign account/identity model:

1. Read the **Independent-Digital-Signature-Platform Directive** and this directive before authoring UI or account/identity logic.
2. Never add upload/authoring controls to `apps/sign-web`.
3. Build the sender/authoring experience as a separate authenticated surface consuming the E-Sign command API — never as an ATS-private fork.
4. Preserve the retained Sign Web flow; productize it, do not rewrite it.
5. Gate send authority on E-Sign entitlement + org role, never on bare Aramo authentication.
6. Keep the signer's core flow account-free; when an account exists, keep the capability — not the session — authoritative, and handle account mismatch explicitly.
7. If a requested change would merge the sender and signer trust contexts, or would make the signer surface an authoring surface, HALT and surface the conflict to the PO.

---

*End of directive. Aramo E-Sign already has the signer side (`sign.aramo.ai`). The independent product requires building the sender/authoring side (`esign.aramo.ai`), completing the signer document-review experience, and standing up a standalone account/identity model — a shared Aramo identity with per-product entitlement, entitlement-gated senders under an E-Sign organization, and a capability-authenticated signer who never needs an account, where even an account-holding signer is authorized by the signing link, not the session. Two scoped surfaces + one account model, under the Independent-Digital-Signature-Platform architecture, with the authenticated-sender and capability-authenticated-signer trust contexts kept strictly separate. Model ratified; implementation deferred.*
