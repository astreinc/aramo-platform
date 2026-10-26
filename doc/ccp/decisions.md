# CCP decision register (recorded rulings required by the Program Build Directive schedules)

| ID | Decision | Ruling | By / date | Governs |
|---|---|---|---|---|
| A2-B | Policy boundary semantics | Inclusive: discount ≥ 20% and credit ≥ $500 escalate; an extension ≤ 14 days is in-limit. Rolling 90-day frequency window. 30-day cumulative cap over rolling 12 months. 72 h expiry; expired at exactly 72 h. | PO, 2026-10-24 | CCP-A2, A8 |
| Q1 | Chain for policy activation (and rollback) | **Finance → Owner** | PO, 2026-10-24 | CCP-A3 |
| Q14 | Open requests per tenant × product | **One open request per tenant × product** | PO, 2026-10-24 | CCP-A3 |
| Q7 | Chain for an out-of-limit support extension | **Finance** (below-threshold chain) | PO, 2026-10-24 | CCP-A8 |
| Q2 | Role changes that are not owner or finance | **Need a distinct platform_owner** | PO, 2026-10-24 | CCP-A9 |
| Q5 / NC-4 / NC-5 | In-flight approvals when a role is revoked or the policy changes | **A signature stays valid. The request keeps its snapshotted policy version and chain. Eligibility and chain fulfillability are re-checked at APPLY time; apply is refused if the chain is no longer satisfiable by currently eligible distinct humans.** | PO, 2026-10-24 (Architect-owned item, ruled by the PO; flagged for Architect ratification at the program acceptance review) | CCP-A3, A6 |
| TD-A1-11 | The two "superseded" scope mappings in the `scope.dto.ts` deferral comment | **Confirmed as written** | PO, 2026-10-24 (Architect-owned; flagged for ratification) | CCP-A1 |
| TD-A1-12 | The stale "(super_admin only)" text on `platform:tenant:read` | **Fix it.** The seed description now names super_admin and the six commercial roles (console entry, A0-C5; CCP-FU-1). This is seed text only: existing databases keep the old description, because the seed upsert never updates an existing row. The A1 regression fingerprint records this deliberate change. | PO, 2026-10-24 (Architect-owned; flagged for ratification) | CCP-A1 |
| B5-P | UI slice for the policy screen | B5 | Lead, 2026-10-24 (within the PBD schedule) | CCP-B5 |
| B4-C | Backend owner for contract evidence | B4 (PBD B4 row) | Lead, 2026-10-24 | CCP-B4 |
| TD-A2-1 | Exact-instant edge of the rolling windows | **Half-open:** a period that has fully elapsed at `now` no longer counts. A prior extension exactly 90 days old does not block a new one; an extension exactly 365 days old leaves the 30-day cap; grace ends at exactly 7 days. This matches the 72 h expiry rule and the existing grace check. | PO, 2026-10-25 | CCP-A2, A8 |
| TD-A2-2 | "Above" (Charter §7) vs ≥ | **≥ (inclusive)**, per the PO-confirmed boundary semantics (Charter §14 item 2 delegates this to the PO) | PO, 2026-10-24; recorded for the Architect | CCP-A2 |
| TD-A2-3 | Credit in a currency other than USD | **Escalates** (`CURRENCY_NOT_COVERED`), never converted | Executor choice (fail-closed); recorded for PO/Architect | CCP-A2 |
| **TD-A3-0 / NC-5** | Architect ratification of the PO's NC-5 ruling | **RATIFIED by the Lead Architect, 2026-10-25.** (1) **At approval:** verify identity, authorization, separation of duties, approval sequence and request validity, and record the approval as **immutable historical evidence**. (2) **At apply:** re-check that each approval is still eligible under the **policy version and approval-chain rules fixed for the request**, never a newer policy version. If eligibility is lost (for example, an approver's role was revoked), **refuse application, fail closed, with no commercial mutation**, and **never delete or rewrite the original signature**. A signature is evidence that the person approved at that time; it is not a permanent authorization. **Required acceptance tests:** role revocation between approval and apply; a policy-version change after request creation, where revalidation uses the snapshotted version; preservation of the original signature after an apply refusal. The program acceptance review verifies conformance; it does not reopen the decision. Merge and deployment are not authorized by this ruling. | Lead Architect, 2026-10-25 | CCP-A3, A6 |
| TD-A3-5 | Who may REQUEST governed policy and role changes | **POLICY_ACTIVATE is requested by finance_admin. ROLE_GRANT and ROLE_REVOKE are requested by platform_owner**, and approved by a **different** platform_owner (Q2). Implemented in CCP-A9; until then, creation stays refused (`requester_authority_undefined`). | PO, 2026-10-25 | CCP-A3, A9 |
| TD-A3-2 | Chains for actions with no money threshold | **Approved.** Subscription open, change and end, product grant and revoke, conversion, and escalated extension use the **Finance-only** chain. **PLAN_RETIRE uses the catalog-publish chain (Finance → Owner).** | PO, 2026-10-25 | CCP-A3 |
| TD-A3-6 | Who fills a step | **Approved.** A Finance step can be filled only by a **finance_admin** (a platform_owner cannot). Policy and role steps require the role plus its approve scopes. One person still never fills two steps. | PO, 2026-10-25 | CCP-A3 |
| TD-A5-1 | Where subscription terms are read from | **Implemented: allowances, capacities and terms resolve through the subscription's PINNED PlanVersion**, required by MP-A2 N-15, N-18 (grandfathering) and N-3(c). v1 is proved byte-equal to the live child rows. This conflicts with the wording in MP-A2 N-1, which names the plan child rows as the "sole authorities". Reversible in two reader helpers, with no schema change. | Executor (A5); **RATIFIED by the Lead Architect, 2026-10-25** | CCP-A5, A6, C1/C2 |
| TD-A9-16 | Which slice applies POLICY_ACTIVATE | **B5** (policy screen and governance), which adds the backend apply for POLICY_ACTIVATE (snapshot re-check per NC-5) together with the policy UI. Until then, requests can be created and approved but not applied. | Lead, 2026-10-25 (within the PBD schedule) | CCP-B5 |
| TD-A9-1 | Role-change apply path | Accepted: a narrow ROLE_GRANT/ROLE_REVOKE apply inside A9. **A6's guard-function replacement MUST preserve these transitions** (A6 instructed). | Lead, 2026-10-25 | CCP-A9, A6 |
| TD-A5-1 ruling detail | Pinned version = the tenant's commercial agreement snapshot | **RATIFIED.** (1) Every subscription references the `plan_version_id` governing its terms. (2) Allowances, quotas, feature limits and version-governed restrictions resolve from that pinned version. (3) Publishing, retiring or replacing a version never changes existing subscribers. (4) Changing `plan_version_id` happens ONLY through an authorized lifecycle transition. (5) Published versions stay immutable after retirement. (6) Negative tests prove catalog changes do not alter existing subscriptions, Sign and Astre-shaped included. Platform-wide security and operational controls apply independently and are never bypassed by grandfathering. | Lead Architect, 2026-10-25 | CCP-A5, A6, C1/C2 |
| Transition controls T1–T12 | Governed subscription transitions | Every supported transition SHALL satisfy: T1 authorization (maker-checker for MANUAL/contract); T2 eligibility (tenant, product, state, action, target version PUBLISHED); T3 old/new `plan_version_id` recorded; T4 versioned policy and chain with distinct-human approval and apply-time re-check; T5 billing ownership (governed apply for MANUAL; Stripe commands plus confirmed events for self-service; a Stripe event never overwrites a governed MANUAL contract); T6 effective date, never retroactive; T7 atomic subscription and entitlement for Aramo-owned changes; T8 usage integrity; T9 idempotency and concurrency; T10 full audit (requester, reason, policy version, approvals, old/new terms, effective time, outcome); T11 visible, recoverable failures, never APPLIED early; T12 tenant/product isolation. **Scope:** A5 = versioning, pinning, lookup, grandfathering. A6 = governed MANUAL/contract transitions. C1/C2 = Stripe-owned operations and conversion. | Lead Architect, 2026-10-25 | CCP-A6, C1, C2 |
| T8 usage rule | Usage across a transition | Preserve all consumption and reservation history and **never manufacture allowance** (no reset). The same-period immediate-upgrade example (100→200 after 70 used → 130 remaining) is a sensible default, **not** a universal policy. **No proration, reset, rollover or partial-period/downgrade policy is authorized.** An undefined usage transition **fails closed** and raises a **typed decision request**; no silent default. | Lead Architect, 2026-10-25 | CCP-A6, C2, later lifecycle slices |
| Docker memory 8→10 GB | Local build environment | Optional; deferred until builds are idle. Do not restart Docker during active CCP builds. | Lead Architect, 2026-10-25 | Environment |

## A6 merge (lead, 2026-10-25)
- **TD-A6-25 (post-merge lead fix, guard union):** A6 modelled the A9 role branch from a description. On merge it had dropped A9's "APPLIED requires `applied_at`" rule for role actions (A9-TRG-1 asserts it). Restored as a generic check for every action, with A9's exact message, in `20261025200000_ccp_a6_transactional_apply`. The A6 both-sides check still follows it.
- **TD-A6-26 (post-merge lead fix, TS mirror):** A6 widened `canTransition` to an action-agnostic union, and A9's `canTransitionFor` built on it, so in TS every action could reach APPLYING / APPLY_FAILED. `canTransitionFor` now mirrors the DB guard per action: A3 base, plus the A9 set for role actions, plus `COMMERCIAL_A6_APPLY_TRANSITIONS` for the four A6 actions, and nothing for the others (POLICY_ACTIVATE stays unreachable until B5, per TD-A9-16). A9-U-4 has been re-based on the A3 table.
- **Open TD-A6 items needing a ruling:** TD-A6-3 (who may apply), TD-A6-5 (an APPROVED request holds the open slot indefinitely), TD-A6-12 (held activation not shown to the tenant), TD-A6-13 (plan-version publish/retire apply unowned), TD-A6-18 (DR-A6-1…4 usage treatments). All are listed in `doc/ccp/slices/CCP-A6-acceptance.md`.

## Architect dispositions on A6 (2026-10-25)
- **TD-A6-3: APPROVED.** The original requester may run apply after the required independent approvals. Approval and application are separate authorities. At apply time, these are revalidated: request state, approval validity (chain, signatures, NC-3/NC-4 eligibility of the approvers), the requester's current authority, eligibility, the current target subscription state, and idempotency. The payload is immutable and bound to its checksum; any change needs a new approval. Service-principal apply is NOT authorized.
- **TD-A6-5: REFINEMENT REQUIRED → HALT (policy amendment required).** The ruling proposes a separately configurable apply TTL, initially 72 h after final approval, with the request moving to APPLY_EXPIRED, its open-request slot released, and in-progress apply and recovery left untouched. Lead check against LOCKED authority:
  - Charter §7 (D5, PO-MANDATE) enumerates the v1 policy keys exactly. "Approval expiry (TTL) 72 h" is defined as "a pending request expires after this". There is no apply-deadline key.
  - Policy values must not be code constants (Charter §7; PBD A2 HALT row).
  - No LOCKED instrument admits an `APPLY_EXPIRED` state.

  So a distinct apply TTL needs a policy amendment (a new D5 key, carried by CommercialPolicyVersion v2 and activated through POLICY_ACTIVATE) plus a state-machine addition. Nothing is built until it is LOCKED. The draft amendment is at `Aramo/documents/CCP-A6-Apply-TTL-Policy-Amendment-DRAFT-20261025.md`. Interim: unchanged; APPROVED requests keep the slot.
- **TD-A6-12: APPROVED WITH CLARIFICATION.** Held-activation details (reconciliation flags, manual-contract details, operator explanations) stay operator-only. The tenant-facing state must never report activation falsely and must not end the MANUAL subscription. It offers a safe billing-support outcome ("Subscription activation pending — contact support"). Built in A6-R only where the Conversion Rule covers the tenant surface; otherwise it is recorded.
- **TD-A6-13: ASSIGNED to CCP-B2.** B2 owns the catalog publish/retire lifecycle. Its backend command (the governed apply of plan-version publish/retire through the approval engine) must land before B2 UI acceptance. It is built as **CCP-B2-backend** on the A6 apply infrastructure, in its own commit; A6 is not expanded.
- **DR-A6-1 (downgrade):** refuse immediate application where consumed + reserved usage exceeds the new effective limit. No negative allowance, forgiveness or silent reset.
- **DR-A6-2 (cross-period):** fail closed.
- **DR-A6-3 (open reservations):** preserve every valid reservation; refuse any transition that would invalidate capacity commitments or cause double consumption.
- **DR-A6-4 (future effective date):** fail closed; never APPLIED early; no scheduler.
- **All refusals:** a stable typed code, an operator-facing explanation, an audit row, test coverage, and no partial state.
- **Still gated:** refund policy, Stripe Tax, legal terms, enterprise invoicing, live Stripe and unapproved product pricing.
- **Not authorized:** no publication, merge to main, deployment or production activation.

## Architect / PO decisions (2026-10-25, second disposition)
- **TD-A6-5: APPROVED for drafting and LOCK.** The apply TTL is a distinct, policy-versioned value: 72 h from final approval. At exactly the deadline, an unstarted apply expires (half-open window, TD-A2-1). An apply already in APPLYING follows recovery semantics. Expired requests keep their audit and approval history, release the open-request slot and cannot be applied; recovery needs a fresh request. Policy clocks: the approval TTL runs 72 h from when the request is submitted (D5); the apply TTL runs 72 h from final approval (amendment). **Implementation waits for the formal amendment to be LOCKED.**
- **D5: CONFIRMED by the PO,** subject to the apply-TTL amendment being LOCKED.
- **TD-A6-R-1: APPROVED.** A same-period downgrade is allowed only when authoritative consumed usage plus non-overlapping outstanding reservations is ≤ the new allowance. It is revalidated atomically at apply time; no reset, no proration. Example: 70 consumed + 10 reserved = 80 ≤ 100, leaving 20 available. Cross-period, proration and future-dated changes are not authorized.
- **TD-B1-2: APPROVED.** Commercial roles keep Dashboard access, with backend-enforced, role-scoped data visibility. No monetary data on general dashboard widgets; money stays on authorized Finance surfaces.
- **DV-B2-02: APPROVED.** Prototype-only SAMPLE labels are removed where real data is shown. Genuine demo or synthetic data stays explicitly labelled.
- **TD-D1-3: PREFER a separate append-only change log** linked to the ledger record, preserving the authoritative usage ledger's semantics.
  - A column-plus-trigger approach is acceptable only if D1 proves that it preserves ledger immutability, introduces no competing totals, and is simpler.
  - There must be no second usage ledger and no new balance or consumption authority. Otherwise, return a bounded design divergence before implementation (HALT).
- **TD-B2-3: APPROVED, requester-only (v1).** The Apply action is offered only to the original requester, only when the request is approved and actionable. Approvers do not gain apply authority by approving. The backend independently enforces the actor (= `requested_by`), the immutable payload, the approved state, the unexpired application authority (once the TTL is LOCKED) and current eligibility. **This narrows TD-A6-3 as built:** A6 admitted any holder of the action's requester scope.
- **Still gated:** refund policy, Stripe Tax, approved legal terms, enterprise invoicing. No push, PR, merge, deployment, production migration or live Stripe.

## Architect disposition: integration wave (2026-10-25)
- **TD-B5-1 APPROVED:** POLICY_ACTIVATE uses APPROVED → APPLYING → APPLIED. The request is APPLIED only after the policy activation commits. Retry and APPLY_FAILED semantics are preserved. Approval evidence is distinct from completed execution: an applied activation never stays APPROVED. (Implemented after the B5 merge, by the B5 owner, as a follow-up; not by the merge executor.)
- **TD-B4-2 CONFIRMED:** contract amend/end stays Finance-only under TD-A3-2. No Finance → Owner chain to match the prototype.
- **TD-B4-3 APPROVED (preserve RBAC):** catalog_manager gets no `platform:subscription:read`. Contracts is hidden or disabled for that role, and the backend still enforces it.
- **TD-C1-4 APPROVED:** a verified, provider-authoritative expired checkout session may move its matching intent to EXPIRED.
  - The original events are preserved.
  - Late or out-of-order webhooks cannot activate or erase a governed subscription.
  - Expiry comes from Stripe evidence, never a local timer.
  - Replay is idempotent.
  - It never bypasses the MANUAL conversion rule.
- **TD-A8-6 APPROVED:** support overlays may apply to Stripe-owned PAST_DUE subscriptions through the separate overlay only. They never mutate Stripe-owned rows, and Stripe's PAST_DUE status stays accurate.
- **TD-A8-5 APPROVED:** support_admin requests removal, Finance approves independently. Removal is audited, does not bypass recorded billing or entitlement state, and effective eligibility is recalculated at once.
- **Gate rule:** after each merge, verify the affected Pact, integration, authorization, migration and contract gates **on the integrated branch**. Worktree-only results are not proof that the integrated branch is green.
- **Still not authorized:** push, PR, merge to main, production migration, deployment, live billing.

## Merge train (2026-10-25): B1 → B2 → A6 (A6-R + B2-backend) → B5 → B4 → C1 → C3 → C6 → A7 → A11 → A8 → D1 (D1-R) → D3
Post-merge fixes made on the integrated program branch (TD-MERGE-n). Each merge is its own commit.

- **TD-MERGE-1 (B1, pact):** B1's inbox interaction "an inbox read of every change request by finance_admin" matched every row of a mixed page against the CREDIT payload template (`amount_minor`, `currency`). On the integrated branch the A6 provider states also leave SUBSCRIPTION_OPEN rows, so verification failed (3 rows). The inbox row now contracts `payload` as an object only (`like({})`); per-action payload keys stay contracted by the per-action interactions.
- **TD-MERGE-2 (B1, vocabulary):** `doc/ccp/decisions.md` (TD-A6-5 second disposition) carried a Tier-2 term from `scripts/verify-vocabulary.sh` (pre-existing at `18b2c032`); reworded ("72 h from when the request is submitted (D5)", the Lead's wording). No exemption added.
- **TD-MERGE-3 (pre-existing):** `npx tsc --noEmit -p pact/provider/tsconfig.json` failed at `pact/provider/src/verify-sign.ts:850` (an A6 state handler using `{ setup, teardown }`; present since `b03bdbde`). Fixed at the A6 merge, TD-MERGE-11.
- **TD-MERGE-4 (B2, backend unions):** `platform.module.ts` controllers and `subscription.module.ts` providers/exports (both `register` paths) merged into one array line each (A6 apply + D1 usage + B2 catalog); error-code registry, `aramo-error.ts`, `error-codes.spec.ts`, `openapi/common.yaml` (D1 + B2 codes, tuple order D1 then B2); `openapi/platform.yaml` path blocks (A6 `/apply` then the three B2 catalog paths, re-assembled from the interleaved hunks and parse-checked); `api-surface-manifest.json`; `verify-orphan-scopes.ts` (union of removals: D1 removed `platform:subscription:read`, B2 removed `platform:catalog:read`; B2's longer `platform:catalog:draft` reason kept); provider: `applyCcpA6Schema` (replaces B2's narrower `applyCcpCatalogSchema`) plus B2's `freshPlan` helper and catalog states next to the A6/D1 ones (suffix trap: the `}` / `},` closers re-attached to each side).
- **TD-MERGE-5 (B2, de-duplication):** the CCP design copy `doc/design-reference/platform-admin/ccp/CCP-UI-v1_0/` was byte-identical to B1's `doc/design-reference/ccp/CCP-UI-v1_0/` and is removed; B2's prototype opener `e2e/support/ccp-proto.ts` is removed and its states use B1's `e2e/support/proto-ccp.ts` with `hash: 'catalog'`; B2's MANIFEST.sha256 byte check is folded into B1's opener. B2's e2e personas `catalogManager` / `platformOwner` (same scope sets, same people) are replaced by B1's `ccpCatalog` / `ccpOwner`.
- **TD-MERGE-6 (B2, permissions):** B2's `catalogRead` / `catalogDraft` moved from `PLATFORM_PERMISSIONS` into B1's `COMMERCIAL_PERMISSIONS` (one map); `CatalogView` re-pointed. The `platform:catalog:read` label keeps B1's wording ("View the commercial catalog"); `platform:catalog:draft` keeps B2's.
- **TD-MERGE-7 (B2, route):** `/commercial/catalog` now renders `CatalogView` behind B1's `commercialGate` (B1's placeholder removed). Two expectations updated: B1's placeholder spec now probes `/commercial/subscriptions`; B2-W-ROLE now expects B1's Commercial access-denied card ("This account can't open Commercial catalog", Super admin) (closes TD-B2-7).
- **TD-MERGE-8 (B2, pact):** the inbox row also drops `product_key` (B2 catalog requests carry `null`); `errorBody` in B2's catalog consumer takes `details: unknown` (a `like({})` matcher did not type-check under `tsc -p`).
- **TD-MERGE-GUARD-1 (A6 merge; Lead rule):** six slice migrations each re-create `subscription.guard_commercial_change_request()`, and the last-sorting one silently wins. Every slice migration is left exactly as its slice wrote it. The integrator-owned `libs/subscription/prisma/migrations/20261027000000_ccp_guard_union/migration.sql` sorts after every CCP migration and re-creates ONLY that function with the union of every merged branch, in labelled `[union block: …]` sections copied verbatim from their sources (at this merge: A3 base, A9 role pair, A6, TD-A6-25 generic APPLIED-needs-applied_at, CCP-B2-backend catalog, A6-R APPLY_EXPIRED; the A6-R body already carried A6 + B2-backend verbatim, so the union body equals it plus labels — diffed). Slice triggers, deferred triggers, tables and CHECKs stay in their slices. The file is undeployed and is updated in place when a later branch adds a guard branch. Its TypeScript mirror is `canTransitionFor`; the new spec `libs/subscription/src/tests/ccp-guard-union.integration.spec.ts` applies the full chain and probes the LIVE function for every action × kind × from × to (14 × 3 × 10 × 10 = 4,200 probes, each in a rolled-back transaction) and asserts it equals the mirror (GUARD-UNION-1), and that the live body is the union file (GUARD-UNION-2).
- **TD-MERGE-9 (A6 merge, TD-B2-3 requester-only):** B2's catalog Apply / Retry apply button now renders only when the request read (`GET /platform/commercial/change-requests/{id}`) returns `apply_actionable: true` for the caller (was: every catalog viewer). New unit test B2-W-APPLY-2. `ChangeRequestDetail` (platform-web) carries `apply_actionable`. B1's drawer has no Apply action (its only apply path is the A9 role change applied inside the final approval), so nothing to wire there.
- **TD-MERGE-10 (A6 merge, contract mismatch B2 UI ↔ CCP-B2-backend):** the B2 UI sent `evidence` inside the PLAN_VERSION_PUBLISH / PLAN_RETIRE payload; CCP-B2-backend gives those payloads a closed key set (`plan_version_id[, provider_price_ref]`) and refused it (400 `evidence is not a field of this action`; B2-RI-CHAIN, B2-RI-RETIRE and the publish pact failed). Resolved without a backend change by the convention CCP-B5 already uses: the evidence travels in the reason (`<reason>\n\nEvidence: <evidence>`). Updated: `catalog-api.ts`, CatalogView.spec, the catalog consumer interaction, the platform-admin B2 route spec. **Lead to confirm** this convention (no information is lost; the approvers see it in the reason).
- **TD-MERGE-11 (A6 merge):** `verify-sign.ts` `{ setup, teardown }` handler cast (`as never`) with a comment; pact-js accepts that shape at runtime (StateFuncWithSetup) but the Verifier options type intersects it with the bare function signature. No behaviour change; `tsc -p pact/provider/tsconfig.json` clean.
- **TD-MERGE-12 (A6 merge):** schema `CommercialChangeRequest.state` comment and column alignment from A6-R; `CommercialCatalogApplication` appended after the D1 models (suffix re-attached; 30 + 1 = 31 models); `subscription.module.ts` exports union (`CommercialCatalogApplyService`); consumer header lists A6/B2-backend apply plus D1 routes, and B2-backend's publish-apply describe appended after D1's (suffix re-attached). Pact files regenerated from empty (platform-web and the three sign consumers). B1 test fixture carries `apply_actionable: false`.
- **Open for the Lead (no change made):** A6-R admits APPLY_EXPIRED only for the A6 and CCP-B2-backend action types. A7 ENTITLEMENT_REVOKE and A8 SUPPORT_EXTENSION (NORMAL) also apply from APPROVED / APPLY_FAILED, but no slice adds them to the APPLY_EXPIRED branch, so the union keeps them out. Whether the apply deadline should cover them is a policy question.
- **TD-MERGE-13 (B5, de-duplication):** (a) B5 and B1 each added `e2e/support/proto-ccp.ts` (add/add). B1's opener is kept; B5's `startRoute` Tweak and its `ccpCall` / `settleCcp` helpers are folded into it (B5's ccp-data.js v0 patch is equivalent to B1's post-load v0 filter). (b) CCP-B2's `CommercialRequestDialog` / `ChainPreview` and CCP-B5's `GovernanceRequestDialog` / inner `ChainPreview` were two builds of the same handoff §5.10 block. B2's is kept; `GovernanceRequestDialog` is now a thin adapter over it (B5 call sites unchanged: Reason + Evidence fields via `RequestField`, `[setting, before, after]` rows, the chain as data; tone privileged/danger/normal → terra/danger/mid; `alert` or `error` → the one refusal alert, commit disabled while `alert` is set). B2's dialog gains B5's hidden "Before:" / "After:" text on changed rows (a11y) and a `ReactNode` sub-line. `governance-components.css` keeps only the role-toggle field styles; B5's duplicate tokens `--pw-gov-changed-bg` / `--pw-gov-shadow-dialog` (TD-B5-20) are replaced by theme.css's `--pw-ccp-diff-bg` / `--pw-shadow-dialog-ccp` (same values). B1's `BeforeAfterDiff` (the drawer's three-column variant) is a different design component and stays.
- **TD-MERGE-14 (B5, rail/routes):** `/commercial/policy` and `/commercial/audit` render B5's views behind B1's `commercialGate` (B1 placeholders removed; super_admin gets the Commercial card, B5 §11). `/admins` opens for `platform:admin:invite` OR `platform:approval:read` (B5), and the rail's Platform admins item gains `orScopes: [platform:approval:read]` so it shows for the same roles. B5's local scope constants replaced by `COMMERCIAL_PERMISSIONS`.
- **TD-MERGE-15 (B5, backend unions):** `validatePayload` POLICY_ACTIVATE closed key set (B5) placed before the A6/B2-backend cases (the `}` closer re-attached); `get()` returns B5's `effect_applied_at` enrichment AND A6-R's `apply_actionable`; module providers/exports, controllers (B5 governance controller), `index.ts` exports, manifest, consumer vitest comment unioned; `openapi/platform.yaml` built by applying B5's own diff (vs its base `b4a3f5f0`) onto HEAD (interleaved hunks), then checked: path set = HEAD ∪ B5 with every operation's responses equal, 121 + 12 = 133 schemas; provider: B5 policy states appended after the B2 catalog states (suffix re-attached). No guard change (B5 keeps POLICY_ACTIVATE APPROVED; the TD-B5-1 follow-up is the B5 owner's).
- **TD-MERGE-16 (B4, apply service):** B4 was built on A6 (`078d4f78`); A6-R since replaced the T8 helper `assertUsageDefined` (refuse any lowered term) with `assertUsageFits` (TD-A6-R-1 / DR-A6-1…4: a lowered term applies while consumed + reserved fit). Union: B4's terms-only amendment path (same version + a contract block → no re-pin, no usage check) is kept, and a version change calls A6-R's `assertUsageFits` (B4's call to the removed helper re-pointed; B4's copy of the old helper dropped). Failure codes: A6-R's DR-A6 codes plus B4's three contract codes. `applyContract` added next to `assertUsageFits` (suffix re-attached). Import group order fixed (lint).
- **TD-MERGE-17 (B4, unions):** schema (Contract + ContractAmendment after the D1 models, suffix re-attached; 31 + 2 = 33 models); `index.ts`, module providers/exports (both paths), controllers (contract controller), manifest; `openapi/platform.yaml` from B4's own diff onto HEAD (paths = HEAD ∪ B4, responses equal; 133 + 7 = 140 schemas); consumer header/constants/GATE_ROUTES (D1 + B4 rows); provider: B4 `recordedContract` helper next to B2's `freshPlan`, its state next to B5's (suffix re-attached). B4's prototype opener `e2e/support/ccp-proto.ts` removed (third copy; B1's `proto-ccp.ts` already carries its persona / demoState / startRoute props); `ccp-contracts.spec.ts` re-pointed. B4's design copy under `doc/design-reference/ccp/CCP-UI-v1_0/` was byte-identical (no diff).
- **TD-MERGE-18 (B4, route + TD-B4-3 check):** `/commercial/contracts` renders `ContractsView` behind B1's `commercialGate` (placeholder removed); B4's `/admins` line dropped in favour of B5's. Integrated-branch check of TD-B4-3: the rail filters by read scope, so catalog_manager (no `platform:subscription:read`) has no Contracts item (B1's rail matrix: Approvals, Catalog, Policy), and a deep link renders the in-shell access-denied naming `platform:subscription:read`: new unit test "TD-B4-3 (merge train) catalog_manager …" in `commercial-visibility.spec.tsx`. The backend still refuses (contract routes gate on `platform:subscription:read`; B4 pact GATE_ROUTES).
- **TD-MERGE-20 (C1, unions):** schema (BillingProviderCommand + BillingWebhookInbox after B4's models, suffix re-attached; 33 + 2 = 35 models); module: C1's `BILLING_PROVIDER_COMMAND_PORT` import line replaces the HEAD import of the same file (one import), providers and both export lists unioned; platform-admin controllers (billing controller); manifest; `verify-orphan-scopes.ts`: union of removals (D1 `platform:subscription:read`, B2 `platform:catalog:read`, C1 `platform:billing:read`; no CCP read reservation remains); `openapi/platform.yaml` from C1's own diff onto HEAD (one rejected hunk = the new "Platform Commercial Billing Operations" tag, inserted by hand; paths = HEAD ∪ C1 with equal responses; 140 + 5 = 145 schemas); consumer header, constants, GATE_ROUTES (D1 + B4 + C1) and the C1 describes after D1's (suffix re-attached); provider: C1's two states after B2-backend's. No guard change. Note for C2: C1's provider state seeds a CONVERSION request with the payload `{pact_fixture: …}`, valid only while CONVERSION has no payload schema.
- **TD-MERGE-19 (frontend, after B1 + B2 + B5 + B4):** the Commercial rail links every built screen: Approvals (B1), Catalog `/commercial/catalog` (`platform:catalog:read`), Policy `/commercial/policy` (`platform:approval:read`), Audit `/commercial/audit` (`platform:commercial:audit:read`), Contracts `/commercial/contracts` (`platform:subscription:read`); every one renders its real view behind B1's `commercialGate` (Subscriptions stays B1's designed placeholder; no slice builds it yet). B1's drawer already opens from `?request=<uuid>` (`ApprovalsInboxView` reads `params.get('request')`), so B2's and B5's links to it work unchanged. Parity, on `PW_E2E_PORT=4420`, logs and outputs under the merge executor's scratch directory: full visual project 263 passed, 5 flaky (passed on retry: ccp-admins-last-owner @900, ccp-catalog-published @1440, lib-create @900, matching @1440, skill-relationships @1440), 1 failed: PLATFORM-UX-1 `studio-preview-zoom @900`, 61 px on every attempt including a re-run alone, scattered glyph edges in the Template Studio preview text and the avatar initials, no layout difference; no CCP file touches the Studio, so it is recorded as unresolved, not caused by the train. axe + keyboard projects: 162 passed. **DV-B2-01 removed:** the catalog states now mask only B1's own DV-C1 (rail) and DV-C2 (⌘K) shell divergences; the 14 `ccp-catalog-*` references were re-captured from the pinned file with `PW_STATE=ccp-catalog` and all 14 comparisons pass. **TD-B4-6 crop retired:** the B4 page states compare the full viewport with the same two B1 masks; the 10 `ccp-contracts-*` page references re-captured; 15/15 pass. **DV-B5-01 crop kept:** a full-page trial passed for the three policy states but failed for Audit (53 px on the Export CSV glyph, every attempt) and Platform admins (the build shows no environment-bar CCP context line on `/admins`; 571 / 1,301 / 1,412 px), so every B5 state stays cropped (trial files deleted). No PLATFORM-UX-1 baseline was re-captured or modified (`git status` shows only `ccp-catalog-*` and `ccp-contracts-*` references). `tsc -p apps/platform-web/e2e/tsconfig.json` is clean (the two new B4 shell masks carry their DV ids; B5's keyboard journey had an implicit-any `(b)` parameter, typed `unknown`).
- **TD-MERGE-21 (C2, guard + apply deadline, TD-C2-7):** C2's two delimited CONVERSION blocks are folded verbatim into `20261027000000_ccp_guard_union` (the transition branch next to B2-backend's; the attempt / APPLY_FAILED / APPLIED block after B2-backend's attempt rules); `canTransitionFor` already mirrors them (GUARD-UNION-1 green with CONVERSION). Deadline naming unified on A6-R's: the conversion apply reads the deadline with `CommercialChangeRequestService.applyDeadlineOf` (policy key `apply_expiry_hours` of the snapshotted, checksum-verified version) and refuses with `APPLY_EXPIRED`; C2's `apply_deadline_hours` key, its parser `applyDeadlineOf`, `APPLY_DEADLINE_POLICY_KEY` and the codes `APPLY_DEADLINE_PASSED` / `APPLY_DEADLINE_POLICY_MALFORMED` are removed (index exports, OpenAPI wording, C2-U-5 rewritten against the A2 parser). A CONVERSION past its deadline is refused with no state change (the guard admits APPLY_EXPIRED only for the A6 + B2-backend set; a CONVERSION in APPLYING never expires). **Found at this merge and fixed:** A6-R's `expireApplyIfDue` / lazy read expiry tried APPLY_EXPIRED for ANY APPROVED request past a deadline, which the guard refuses for every other action type (an applied POLICY_ACTIVATE stays APPROVED, TD-B5-1), so a read would have failed once a v2 policy with `apply_expiry_hours` is active; both are now scoped to the guard's set (`isApplyExpirable`). New tests in `ccp-guard-union.integration.spec.ts`: GUARD-UNION-3 (a CONVERSION with a pending provider command commits in APPLYING; without one it is refused by C2's trigger; SUBSCRIPTION_OPEN, ENTITLEMENT_GRANT and PLAN_VERSION_PUBLISH can never commit in APPLYING) and GUARD-UNION-4 (the expiry leaves CONVERSION, POLICY_ACTIVATE, ROLE_GRANT, ENTITLEMENT_REVOKE and SUPPORT_EXTENSION alone).
- **TD-MERGE-22 (C2, TD-C2-9):** A6-R removed `downgradedTerms`, which C2's ledger imported (compile break). C2 now uses A6-R's `changedTerms` (the set of terms it flags is exactly the set `downgradedTerms` flagged: 'undefined' + 'lowered'), mapped to the same `kind:key` strings, so the conversion keeps its own rule and codes. **Not re-pointed to A6-R's `assertUsageFits`:** that is a behaviour change (TD-A6-R-1 would let a conversion downgrade within consumed + reserved; C2 as built refuses any downgrade or open reservation). Lead to decide.
- **TD-MERGE-23 (C2, unions + C8 evidence):** `commercial-change-request.ts` (imports; B2-backend catalog set + C2 transition table + one combined doc; `canTransitionFor` carries both branches); A9-U-4 re-based (A6 + B2 add the apply set with APPLY_EXPIRED; CONVERSION adds the apply set without it); modules, controllers (conversion controller), manifest, OpenAPI (C2 diff onto HEAD, verified: 145 + 4 = 149 schemas), provider (C2 helpers after B4's `recordedContract`, suffix re-attached; C2 states after B4's). Schema 35 + 1 = 36 models. PBD §7.2 C8 evidence on the integrated branch (`ccp-c2-conversion.integration.spec.ts -t "C2-C8|C2-TDC14"`, 7 passed): C2-C8-1, C2-C8-2, C2-C8-3, C2-TDC14-1, C2-TDC14-2, C2-TDC14-3, C2-TDC14-4. **Watch for A7 / A8:** C2's migration (sorting last of the slices) re-creates `CommercialChangeApplication_action_type_check` from A6's list + CONVERSION, which would drop A7's ENTITLEMENT_REVOKE and A8's SUPPORT_EXTENSION widenings; handled at those merges.
- **TD-MERGE-24 (C3, unions):** module (C3's port import line carries `BILLING_PROVIDER_READ_PORT` next to C1's two ports; the read adapter + `BillingStatusReadService` providers and exports, both paths), controllers (billing-status controller), orphan-scopes (C3 adds a comment only; the stale "2 read reservations remain" line and C3's re-listed `platform:catalog:read` reservation dropped: B2 removed it), consumer (coverage header now 19 routes; GATE_ROUTES C2 + C3; C3's describes after C2's — suffix trap: C2's conversion-read describe lost its closing `});` to the C3 side and was re-attached; 22 + 2 = 24 describes), provider (one `@aramo/subscription` import carrying D1's and C3's names; the C3 in-memory read-port override, its env reset and header note). OpenAPI auto-merged. No migration, no guard change. Two platform-admin specs failed once under load in the full CCP run (`ccp-a1-platform-role-authorization` R-3 dashboard 400, `ccp-c1-billing-operations-authorization` C1-R-2 socket hang up at 30 s) and passed alone (119 / 119, 18 / 18).
- **TD-MERGE-25 (C6):** unions: module (finance report service; a duplicated `forRoot` provider line from the auto-merge removed), controllers (finance controller), manifest, OpenAPI (C6 diff onto HEAD; the rejected "Platform Commercial Finance" tag inserted by hand; paths = HEAD ∪ C6 with equal responses; 153 + 9 = 162 schemas), consumer (coverage header 22 routes; constants, GATE_ROUTES and describes after C3's, suffix re-attached; 24 + 3 = 27 describes), provider ('finance records exist' after C3's states, suffix re-attached). `apps/platform-web/src/dashboard/DashboardView.no-money.spec.tsx` kept (TD-B1-2). Fix: C6-HELD-2 seeded a CONVERSION with a free-form payload (`{c6_fixture: 'held'}`, valid only before C2); it now uses a C2-valid `TO_GOVERNED` held-activation payload; 12 / 12 C6 tests pass. TD-C6-6 (revoked entitlements excluded) is verified at the A7 merge.
- **TD-MERGE-26 (A7, TS side):** A7's `isCommercialApplicable` (A6 ∪ ENTITLEMENT_REVOKE) is the predicate of A6-R's `preflightApply` (A6-R had moved the ACTION_NOT_APPLICABLE check into it with `isA6Applicable`); `applyDomain` / `applyContract` take `CommercialApplicableAction`; B4's terms-only CHANGE keeps `events: sameVersion ? [] : …` and gains A7's `revoke: []`; A6-R's `applyActionable` includes ENTITLEMENT_REVOKE (requester-only Apply). **Mirror:** A7 pointed the revoke at `COMMERCIAL_A6_APPLY_TRANSITIONS`, which A6-R had widened with APPLY_EXPIRED; A6-R's guard branch does not name ENTITLEMENT_REVOKE, so the revoke now has its own `COMMERCIAL_A7_REVOKE_TRANSITIONS` (the A6 pairs without APPLY_EXPIRED) and is not expired by A6-R (still the open Lead question). A9-U-4 re-based accordingly. **TD-A7-7 call sites:** `commercial-apply.service.ts` (A7's own: `MANUAL` for ENTITLEMENT_GRANT, `PLAN` for subscription open/change, granted_by = the applier, change_request_id = the request) and `commercial-conversion.ledger.ts` (C2's governed open by conversion: `PLAN`, granted_by = the conversion's requester, change_request_id = the conversion) — the only `grantCapabilitiesInTx` callers outside the entitlement lib; B4 and C1 have none; provisioning / signup carry A7's own `PROVISIONING` / `SIGNUP`.
- **TD-MERGE-27 (A7, guard + constraint unions):** A7's three blocks folded into `20261027000000_ccp_guard_union` (the ENTITLEMENT_REVOKE transition branch; its attempt rules; the separate TD-A7-2 block = the active-row backstop for A6 APPLIED plus the revoke APPLIED checks). A first fold mis-cut the attempt-rules block (a difflib boundary on repeated `END IF;` lines put the `IF … ENTITLEMENT_REVOKE THEN` line after the rules), which made every state change fall through to "columns change only with a state transition"; GUARD-UNION-1 and 110 integration tests caught it; repaired and every source line re-checked against A3 / A9 / A6 / A6-R / B2-backend / C2 / A7. **New integrator file `20261027000100_ccp_constraint_union` (TD-MERGE-CHECK-1):** `CommercialChangeApplication_action_type_check` is dropped and re-added by A7 (+ ENTITLEMENT_REVOKE), A8 (+ SUPPORT_EXTENSION) and C2 (+ CONVERSION); C2 sorts last, so on the integrated chain it silently dropped A7's revoke (and would drop A8's). The file re-asserts the union (A6 + ENTITLEMENT_REVOKE + CONVERSION so far); A7's `subscription_check` / `revoke_check` and C2's `replaced_check` are each re-created by one slice only. Slice migrations untouched.
- **TD-MERGE-28 (A7, verification):** TD-C6-6 verified on the integrated branch with a new test in `ccp-c6-finance-report.integration.spec.ts` (a governed ENTITLEMENT_REVOKE of `sign`: the row is kept with `revoked_at`, and the reconciliation then reports `present: ['core'], missing: ['sign']`, `ENTITLEMENT_MISSING`). Integration assertion that a revoke apply and (at A8) a bounded support extension both work on the fully migrated schema: the revoke is covered by `ccp-a7-entitlement-revoke.integration.spec.ts` (11 tests) and the new C6 test, both on the full chain incl. both union files. TD-A7-4 helper `libs/common/src/lib/testing/entitlement-migrations.ts` merged as A7 wrote it.
- **TD-MERGE-29 (A11):** merged with no conflict outside the generated repo map (regenerated). The two `package.json` scripts (`ccp:astre-backfill`, `ccp:astre-fact-check`) merged next to the others; `seedCcpCatalog` is exported from `ccp-a3-database.ts`. `ccp-a11-astre-backfill.integration.spec.ts` + `ccp-a11-backfill-guards.spec.ts`: 15 / 15 passed on the integrated branch (full chain incl. A6-R, B4, C1, C2, A7 and both union files); the golden dry-run file `fixtures/ccp-a11-dry-run.golden.txt` matched as committed, so it was not regenerated. The no-service-change assertions are untouched.
- **TD-MERGE-30 (A8, apply service + mirror):** A8 extracted the A6 apply core into `completeInTx` (shared with `applyBoundedExceptionInTx`) on the A6 base; the integrated `apply` had since gained A6-R (requester-only preflight, deadline gate, live-authority re-check, audited refusals), B2-backend (catalog early return), B4 (contract side) and A7 (provenance grant + revoke). Merged as: `apply` = HEAD's, with A8's NORMAL-only rule added inside the audited preflight; `completeInTx` = HEAD's apply core (domain incl. A8's `supportExtensionEffect` with `actor`, B4 contract, A7 grant/revoke, application row incl. `capabilities_revoked`, audit) plus A8's `is_exception` on every event and `kind` / `exception` on the APPLIED event; A8's copy of the removed `assertUsageDefined` dropped; `supportExtensionEffect` returns A7's `revoke: []`. One action set `APPLY_SERVICE_ACTIONS` = A6 ∪ A7 ∪ SUPPORT_EXTENSION drives the preflight and the types. Failure codes: A6-R + B4 + A8 (`EXTENSION_NOT_FOUND`, `EXTENSION_ALREADY_REMOVED`). `applyActionable` includes SUPPORT_EXTENSION (TD-B6-5). **Mirror:** `canTransitionFor(…, kind)` (A8) keeps every HEAD branch; the NORMAL SUPPORT_EXTENSION takes the A6 pairs WITHOUT APPLY_EXPIRED (the guard does not name it); and a mirror gap of A8's own TS (a SUPPORT_EXTENSION of kind MIGRATION was admitted by the A3 base while the guard raises "kind % is not applied") is fixed. `COMMERCIAL_TRANSITIONS` gains DRAFT → APPLYING (A6-SM-1: 13 of 100 pairs); A9-U-4 re-based.
- **TD-MERGE-31 (A8, unions + expectation changes):** guard union gains A8's DECLARE variable, transition branch (EXCEPTION + NORMAL), kind/attempt block (placed right after the transition check, as in A8's source; cut by markers, not difflib, after TD-MERGE-27) and APPLIED checks; every A3/A9/A6/A6-R/B2-backend/C2/A7/A8 source line re-checked present; GUARD-UNION-1 green (4,200 probes incl. the kinds). Constraint union gains SUPPORT_EXTENSION. Schema (SupportExtension after C2's model, suffix re-attached; 36 + 1 = 37 models; the application action comment lists all five widenings); modules, controllers, manifest, `index.ts`; orphan-scopes: union of removals (D1/B2/C1/A8: no CCP read reservation; `platform:subscription:support` removed by A8 together with C1's `platform:billing:read`); OpenAPI (A8 diff onto HEAD, tag inserted by hand, 162 + 5 = 167 schemas; the CommercialChangeApplication action enum gains SUPPORT_EXTENSION, which A8 had left out though its apply returns such rows); consumer (header 24 routes, constants, GATE_ROUTES, describes, suffix re-attached, 27 + 2 = 29 describes; B1's inbox row now admits rule BOUNDED_EXCEPTION and an empty steps array — a mixed page carries bounded exceptions); provider (A8 helper + states, suffix re-attached); `support/ccp-a6.ts` harness returns both B2's and A8's services; `platform-commercial-support-extension.controller.ts` handles the nullable `application` (B2-backend made it nullable). **Expectation changes:** A8-ARCH-3 flipped as instructed (finance_admin's apply attempt is refused with `NOT_REQUESTER` and writes exactly ONE `COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED` row); A8-ESC-APPLY-1 and A8-RI-ESC now expect `NOT_REQUESTER` / `not_requester` (A6-R's requester-only preflight runs before the scope check); A6R-REQ-3 now uses an A8-valid payload and expects `NOT_REQUESTER`. TD-A8-15 / TD-A7-4: the four prefix-pinning specs use A8's `applyRemainingSubscriptionMigrations` (which now also applies both union files) and their entitlement chain is the full lib chain; `subscription-lifecycle.integration` 29 / 29 and apps/api `ccp-a4-ats-sign-availability` 3 / 3 pass. **Open (B6):** B1's `chainName` labels a BOUNDED_EXCEPTION request "Below threshold"; the right label is a design decision for B6 / the Lead.
- **TD-MERGE-32 (B6, frontend):** the rail gains "Support extensions" → `/commercial/support-extensions` (Commercial group, after Audit, scope `platform:subscription:read`, glyph `shield`; not in the CCP-UI v1.0 rail); the route renders `SupportExtensionsView` behind B1's `commercialGate` (B6's local `gate()` and its `/admins` line dropped); `navKeyFor` maps it. B1's visibility matrix test extended (five roles see it; catalog_manager and super_admin do not). TD-B6-13: `SUPPORT_SCOPES` folded into `COMMERCIAL_PERMISSIONS` (+ `subscriptionSupport`, label "Request support extensions"); `support-extension-scopes.ts` removed. TD-B6-12: `SupportRequestDialog` is now an adapter over B2's `CommercialRequestDialog` + `ChainPreview` (B6's preview box kept as body content after the fields); its duplicated dialog-shell, chain, alert and button CSS removed; `--pw-sx-fs-title` / `--pw-sx-ok-bg` / `--pw-sx-shadow-dialog` replaced by `--pw-fs-18` / `--pw-verdict-ok-bg` / `--pw-shadow-dialog-ccp` (same values); B6's unique tokens kept. The swap was kept because both B2's and B6's dialog parity pass after it (the B6 state locator now targets `.pw-crd`; 12 / 12: the B6 dialog states and B2's publish / retire dialogs; two class-name assertions in `support-components.spec.tsx` re-pointed). TD-B6-11: B6's harness files were byte-identical to B1's (`proto-ccp.ts`, personas, `openBuild`, state types: no diff after merge; HEAD's evolved `proto-ccp.ts` kept); B6's element-relative mask change in `parity.spec.ts` / `capture-reference.spec.ts` merged into the one harness. B1 results unchanged except `ccp-rail-group`, whose build image grew by the new item; the B6 item is taken out of layout for that six-item comparison only (DV-MERGE-1, documented in the state), and it passes. TD-B6-5 verified on the integrated branch: new test in `ccp-a8-support-extension.integration.spec.ts` (after Finance approves an escalated extension, `apply_actionable` is true for the requesting support_admin and false for the approver and for another support_admin); B6's UI shows Apply only when that flag is true and the viewer is the requester (B6-F-APPLY). Full visual run after the merge: 269 passed, 8 failed → after fixes the 4 B6 dialog states and both `ccp-rail-group` states pass; PLATFORM-UX-1 `studio-preview-zoom @900` (61 px) and `studio-compare-changes @1440` (66 px, every attempt, glyph edges in the Studio compare dialog's title and selects) remain — Studio files are untouched by CCP; recorded as unresolved, not caused by the train. axe + keyboard: 169 passed.
- **TD-MERGE-33 (D1-R):** `wip/ccp-d1` at its D1-R tip (`ad774a1b`, on `18b2c032`) merged with no conflict (generated repo map regenerated): the D1 migration `20261025240000` is edited in place by its slice (drops `AllowanceUsage.rollup_xid`, adds the append-only `AllowanceUsageChange` log written by an AFTER trigger); schema stays at 37 models (the D1 bookkeeping model is replaced by `AllowanceUsageChange`), prisma valid. Re-run on the integrated branch: the D1 spec, `ccp-a8` (A8's allowance reader and D1's trigger coexist on `AllowanceUsage`), the A7 and A6 apply specs (all inside the 604-test CCP run, all green), the platform-admin Pact provider 2 / 2, and A11 (the golden dry-run file still matches; not regenerated).
- **TD-MERGE-34 (D3):** unions: schema (CommercialOperationalAlert after A8's model, suffix re-attached; 37 + 1 = 38 models), modules (alert service; D1's and D3's opt-in workers side by side in platform-admin), controllers (observability), manifest, `index.ts` (D1 + D3 exports), OpenAPI (D3 diff onto HEAD; the rejected "Platform Commercial Observability" tag inserted by hand; paths = HEAD ∪ D3; 170 + 5 = 175 schemas), consumer (coverage header 28 routes; constants and GATE_ROUTES; D3's describes after the C2 / C3 / C6 / A8 ones, suffix re-attached; 30 + 4 = 34 describes), provider (env reset `CCP_ALERTS_ENABLED` next to D1's and C3's; D3's alert state after C6's, suffix re-attached). Env wiring auto-merged and checked: `docker-compose.prod.yml`, `.env.example`, `.env.prod.example` carry D1's `CCP_USAGE_ROLLUP_*`, C1's `SIGN_BILLING_COMMANDS_ENABLED` and D3's four `CCP_ALERT*` variables; `env:passthrough-check` green. **TD-D3-1:** `ccp-d3-operational-alerts.integration.spec.ts` re-run against the REAL D1 schema: the stand-in table is created only when `UsageRollupRun` is absent, so on the integrated chain it is never created and USAGE_NOT_RECONCILED reads D1's real table (no conflict; left in place, neutral). Fixes: D3's two CONVERSION fixtures used free-form payloads (pre-C2) and now carry a C2-valid structural payload (20 / 20 pass); D1's RO-4 source scan now lists D3's alert service (an observability read of the run log, TD-D3-1), which it had flagged as a fourth reader of the D1 tables.
- **TD-MERGE-35 (B3, after B5-R `cc7804e9`):** `wip/ccp-b3` (`1c5214bb`, base `debd033d`) merged onto `cc7804e9`. Only `subscription.module.ts` conflicted (export arrays, both paths: one line each). `apply_actionable` auto-merged and is the combination asked for: requester-only, human, APPROVED or APPLY_FAILED, for every applyable type (A6, B2-backend, A7, A8 NORMAL, POLICY_ACTIVATE from B5-R, and CONVERSION from B3) with the requester scope; "not expired" holds because `get()` runs A6-R's lazy expiry first (an expired request reads APPLY_EXPIRED, which is not actionable). B3's `/commercial/subscriptions` workbench replaces B1's last placeholder behind `commercialGate`; the dialog's optional "Save as draft", the tenant Commercial tab, `DIVERGENCES.md`, `states.ts`, OpenAPI, manifest, `index.ts`, Pact consumer and provider auto-merged (tsc clean; consumer and provider green). No code reads `effect_applied_at` (dropped by B5-R). One expectation updated: B4-N3-c's source scan now allows B3's read-only `commercial-subscription-read.service.ts` (it LEFT JOINs `Contract` to name the linked contract; plan, version and status still come from the subscription row).
- **TD-MERGE-GUARD-1 / TD-MERGE-CHECK-1 — compensating SQL (gate item 1, 2026-10-25; documented, not shipped).**
  - **Guard union.** `libs/subscription/src/tests/fixtures/ccp-guard-union-compensating.sql`. Compensating the union means re-applying the body it superseded: the guard exactly as the last-sorting slice migration that re-creates it wrote it (CCP-C2 `20261026060000`, the A6 body plus the CONVERSION blocks), copied verbatim. That body lacks the PLAN_VERSION_PUBLISH / PLAN_RETIRE / ENTITLEMENT_REVOKE / SUPPORT_EXTENSION / POLICY_ACTIVATE apply branches and the APPLY_EXPIRED rules. The compensation is therefore refused (RAISE, nothing changed) while a request of those types is APPROVED, APPLYING or APPLY_FAILED, or any request is APPLY_EXPIRED. It is valid only as the first step of rolling back the slices that added those branches (B5-R, A6-R, A8, A7, CCP-B2-backend), each with its own compensation, in reverse order. Otherwise, re-apply the union.
  - **Constraint union.** `libs/subscription/src/tests/fixtures/ccp-constraint-union-compensating.sql` re-asserts `CommercialChangeApplication_action_type_check` as C2 (the last-sorting slice) wrote it: the A6 list plus CONVERSION. It is refused while an ENTITLEMENT_REVOKE or SUPPORT_EXTENSION application row exists.
  - **Proven** on a fresh Postgres 17 by `libs/subscription/src/tests/ccp-merge-train-compensation.integration.spec.ts`. The full chain (every lib migration in the `tools/db-sync-local.sh` order) applies, then:
    - COMP-1: each compensation is refused with dependent data and changes nothing.
    - COMP-2: the four compensations (B5-R, constraint union, guard union, A1) apply in reverse order with 0 errors. The live guard is C2's body, with no union block; the CHECK is the C2 list; the B5-R trigger is gone; A1's rows are gone.
    - COMP-3: the four migrations re-apply with 0 errors and the gated state is back.
  - Result: 4 / 4 tests.


## Architect program acceptance disposition (2026-10-25, on local head 621f1678)
**Status:** CONDITIONAL ENGINEERING ACCEPTANCE. Phases A and B are provisionally accepted; C and D are partial. Final program acceptance is NOT granted; push and the final PR are NOT authorized. Production migration, deploy, bootstrap, backfill and activation are NOT authorized. The one-branch, one-final-PR agreement stands: no intermediate PR.

**Rulings on the 16 decision rows:**

| ID | Ruling | Gate still pending |
|---|---|---|
| DR-C2-1 | Keep the `FINANCIAL_TREATMENT_UNDEFINED` refusal for committed self-service rows: no early cancellation, automatic credit or refund. This is a deliberate v1 product limitation. | Finance and PO, for any later commitment-end treatment |
| TD-C3-5 / TD-C6-1 / TD-D3-13 | Catalog list prices stay readable under catalog authority. Invoice amounts, payment amounts and tenant-specific finance figures need a **dedicated Finance scope**; amend the A1 scope catalog BEFORE exposing them. | The scope-catalog amendment (draft → LOCK) |
| TD-C3-2 | The architecture is approved, NOT issuance: a restricted, least-privilege, read-only Stripe credential for the platform-admin backend, in managed secrets, audited, rotatable, verified for the right account and mode. Never exposed to the browser, never logged, no write authority. C3 stays NOT DELIVERED until the portal configuration AND the credential/security evidence are verified. | Security, at the C3 release gate |
| TD-A7-5 | Deferred governed revocation. Entitlement history is preserved; no destructive automatic revoke. Effective access still fails closed once grace or overlay authority ends, and reconciliation and revocation must never leave indefinite active access. | — |
| TD-A7-3 | Remove the `MIGRATION` default. Provenance must be explicit; fix the 83 fixtures and verify every production write path first. No silent fallback. | — |
| TD-B5R-3 | Accepted for v1, conditionally. The requester-controlled recovery path stays, and the apply-deadline amendment applies where it can. FAILED requests must not become permanently executable or silently release a slot while an operation can still commit. | See TD-ACC-1 |
| DR-C2-2 | Accepted: the release expiry is an approved-request term, at most 30 days, immutable after approval. A policy-managed maximum is possible later. | — |
| DR-C2-3 | Confirmed, conditionally: prior MANUAL-period usage is not carried into a new self-service period. Historic usage is preserved; a period reset must never manufacture allowance or double-count reservations. | — |
| TD-C2-9 | Approved: the stricter v1 refusal stays. Conversion is unavailable with a downgrade or open reservation; the same-period downgrade ruling does not extend to billing-authority conversion. | — |
| TD-MERGE-10 | Accepted for v1: text evidence in the immutable reason, required, auditable and preserved. A structured field comes when a governed use case needs it. | — |
| TD-D3-2 | Confirmed: a stuck Stripe command alerts at 24 h, approval expiry warns 12 h before. Alerts never perform financial actions. | — |
| TD-D3-9 | Accepted for v1 with monitoring: apply-time and read-time expiry are authoritative. A future sweep worker must never be required for an expired request to be refused. | — |
| TD-A6-R-3 | Confirmed: "Subscription activation pending — contact support." It never reveals internal conflicts or implies activation. | — |
| TD-B2-1 | Approved: version-only retirement for v1. PLAN_RETIRE retires a specified plan version, never silently the whole plan. Expose these semantics clearly in the UI and API. | — |
| TD-B3-4 / TD-B6-1 / TD-B6-4 | Conditional design acceptance: existing components are an acceptable interim. Final visual acceptance needs the CCP-UI v1.1 review, including authorization and accessibility behaviour. | Design v1.1 |
| TD-A8-3 | Refined: a non-PAST_DUE row or a missing D9 attestation is an **eligibility refusal**, not an escalation. Escalate only on evidence of attempted bypass, misrepresentation, or another defined policy violation (e.g. a limit breach). | — |

**Other items in the disposition:**
- **Template Studio visual failures** (`studio-preview-zoom @900`, `studio-compare-changes @1440`): handled as a documented baseline exception, provided they are reproducible and no CCP change affects those states.
- **Remaining slices, per PBD §10:** C4, C5 and C7 SHALL be built in Stripe test mode with the designed disabled states and reported NOT DELIVERED until their external decision is verified. **No scope amendment is needed.** D2, D4 and D5 proceed now; D6 follows D1–D5.

**TD-ACC-1 (lead, needs an Architect ruling): B5-R vs AD-2.**
- Amendment A1 AD-2 says a request snapshotted under policy v1 has NO apply deadline. A v1-snapshotted APPLY_FAILED POLICY_ACTIVATE is therefore retryable indefinitely by its requester. The B5-R ruling asks that FAILED requests not become permanently executable.
- Under the LOCKED text, the only in-authority closure is to activate a v2 policy carrying the apply deadline. Even then, the v2 activation request itself snapshots v1.
- **Options:**
  - (a) accept this single edge;
  - (b) amend the state machine so the requester may WITHDRAW an APPLY_FAILED request;
  - (c) amend AD-2.
- Nothing is built until it is ruled.

## Architect final rulings (2026-10-25): Finance amount scope + TD-ACC-1
- **Finance amount scope: RATIFIED and LOCKED.** Filed as `Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope-v1_0-LOCKED.md`, SHA-256 prefix `c3ce572ae19bba55` (sidecar verified; references to A1 `44ac30ce…` and DDR v1.2 `9ef23194…` checked).
  - **FAS-1:** read_only_auditor holds amount-read.
  - **FAS-2:** the scope is `platform:billing:amount:read`.
  - **FAS-3:** support_admin gets a due/overdue boolean only.
  - **Grantees:** exactly platform_owner, finance_admin and read_only_auditor.
  - **Enforcement:** backend-enforced, covering field omission, exports, alert payloads, search, counts, errors, logs and caches.
  - **Catalog totals:** 25 / 205 / 984 → 25 / 206 / 987, recalculated from the seed at implementation.
- **TD-ACC-1: Option B.** The original requester may WITHDRAW an APPLY_FAILED POLICY_ACTIVATE, provided:
  - their current authority is revalidated;
  - reconciliation proves no activation is executing, queued or uncertain;
  - an activation that committed but whose response failed is reconciled to APPLIED, never withdrawn.

  Conditions on the transition:
  - WITHDRAWN is terminal.
  - Signatures, payload and failure evidence are preserved.
  - Withdrawal writes one audit event.
  - The slot is released only when the withdrawal commits.
  - Retry, withdrawal and a new activation are serialized and idempotent.

  AD-2 and the 72 h apply TTL are unchanged; withdrawal is not an extension. Lead check: no LOCKED instrument fixes the transition table (WITHDRAWN appears in no CCP LOCKED text). The table lives in the A3 pre-execution record, so this addition is within program authority.
- **Dependency disposition (same date):**
  - CCP-UI v1.1 is the immediate design dependency, using the prepared prompt unchanged.
  - C3 stays NOT DELIVERED until the restricted credential and portal-configuration evidence are verified. No credential is issued to unblock the schedule.
  - Enterprise invoicing stays disabled (`invoicing.enabled: false`) pending a Finance/PO operating-model decision.
  - C4, C5 and C7 are externally blocked.
  - DR-C2-1 stays fail-closed.
  - Each blocked slice reports engineering-complete, disabled-by-design and release-ready status separately.

## Architect C4 disposition (2026-10-25): implementation conditionally accepted at fb94afe8, NOT DELIVERED
- **TD-C4-1: APPROVED WITH AMENDMENT.** REFUND is a first-class governed action with its own identity: payload, provider references, audit events, reconciliation outcomes. No LOCKED instrument enumerates the action types (the PBD A3 row says only "closed `action_type`"). The successor amendment drafted in `Aramo/documents/CCP-Commercial-Action-Catalog-REFUND-Amendment-DRAFT-20261025.md` LOCKs the full catalog with REFUND in it. REFUND stays disabled for real use until that is LOCKED and the other release gates pass.
- **TD-C4-2: APPROVED.** Every refund goes Finance Admin → Platform Owner: distinct humans, apply-time revalidation, no amount-based bypass.
- **TD-C4-6: APPROVED for v1.** A discount is a one-off percentage on the next eligible invoice only, within policy limits and confirmed by Stripe. Nothing recurring, indefinite or retroactive.
- **TD-C4-12: APPROVED with a safety condition.** The disabled flag blocks NEW external execution only.
  - Reconciliation (webhook or re-fetch, by idempotency key and provider references) of previously initiated commands continues.
  - The request and its slot are held while the outcome is uncertain.
  - Terminal resolution or withdrawal is allowed only after authoritative proof that no refund can still complete.
  - A confirmed refund is recorded as applied.
  - Never a second command, a duplicate effect or a silent slot release.
- **TD-C4-18: CONDITIONALLY ALLOWED.** A separately governed manual credit is distinct from DR-C2-1's prohibition on automatic conversion credits. It does not authorize early cancellation, end a commitment, or lift `FINANCIAL_TREATMENT_UNDEFINED`, and it needs its own approval and an approved credit policy.
- **R3: REQUIRED.** Centralize authorized monetary read redaction under `platform:billing:amount:read`, at each backend projection: change-request reads, audit reads and exports, notifications, financial projections. It produces authorized read representations while retaining complete internal immutable audit evidence. Never redact the stored record itself.
- **Integration requirements:**
  - one integrator-owned union for the Stripe command guard `guard_billing_provider_command()` (C4 and C7), with its DB/TS equivalence verified;
  - re-validate Pact, authorization, provider idempotency, the outbox/inbox and the affected integration suites;
  - investigate the isolated load timeout if it repeats; an intermittently failing integrated gate is not "fully green";
  - record the two e2e lint issues separately, with baseline evidence.
- **Not authorized:** push, PR, main merge, production migration, deployment or live Stripe.

## Architect ratification: commercial action catalog (2026-10-25)
- **AC-1: RATIFIED, the full catalog.**
  - LOCKED as `Aramo-CCP-Program-Build-Directive-Amendment-A1-Commercial-Action-Catalog-v1_0-LOCKED.md`, SHA-256 `ad862360aab001858d3eb093a97e3331e5360bffe46893a62bebdfb425e60e60` (sidecar verified).
  - The closed set is exactly **15 canonical `action_type` values**, reconciled against `COMMERCIAL_ACTIONS`, `resolveRequiredChain`, `chainOf` and `CCP_PLATFORM_ROLE_SEED_BUNDLES` at C4 tip `20218e13`.
  - There is no undocumented type and no authorization drift.
  - Two drafting discrepancies were surfaced and resolved to the implemented chains, with nothing changed:
    - **R-1:** the subscription and entitlement actions plus CONVERSION are Finance-only, with no threshold;
    - **R-2:** PLAN_RETIRE is Finance → Owner.
- **AC-2: RATIFIED, partial refunds allowed**, at most the refundable remainder.
  - The remainder (RF-4) subtracts confirmed refunds, provider-pending refunds, AND outstanding Aramo REFUND requests or commands against the same payment, including uncertain ones.
  - Binding RF-5 applies: tenant, product, payment identity and currency must match.
  - Refunds stay disabled (RF-8) until: (a) the amendment is LOCKED (done); (b) the refund policy is approved; (c) the release gate authorizes it.
  - DR-C2-1 is unchanged.

## Merge train 2 (2026-10-25): R1 → R3 → D5 → D4 → D2 → C5 → C7 → C4 (C4-R) → ACC-1 → FIX1
Gate rule (Architect): every affected Pact, integration, authorization, migration and contract gate is re-verified on the INTEGRATED branch after each merge; an intermittent failure is not green.

- **TD-MERGE-36 (R1, TD-A7-3):** `wip/ccp-r1` merged with no conflict (generated repo map regenerated). R1 edits the A7 entitlement migration in place: no `granted_source` default, NOT NULL. Its 84 fixture sites are fixed. R1's source-scan spec (`libs/entitlement/src/tests/ccp-r1-granted-source-scan.spec.ts`) passes 4 / 4 on the integrated branch: none of the merge-train tests added since R1's base inserts a `TenantEntitlement` row without naming a source.

## CCP-R3 acceptance reconciliation (2026-10-25, on `41a0e3b5`; record `doc/ccp/slices/CCP-R3-acceptance.md`)
- **Finance amount scope implemented** per `Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope-v1_0-LOCKED.md` (prefix `c3ce572ae19bba55`): `platform:billing:amount:read` (0x335) to platform_owner, finance_admin, read_only_auditor; identity migration `20261028060000_ccp_a1a1_finance_amount_scope`; totals 25 / 206 / 987. Field authorization on C3, C6 outstanding, A3 change requests, A2 audit and the B5 export; FA-4 `payment_due` / `payment_overdue` for every billing reader. The FA-9 interim was built first and is superseded.
- **D-R3-1 (Architect to confirm):** C6 list prices are read as FA-3 catalog prices and stay visible to every billing reader; only the amount owed is withheld there.
- **D-R3-2:** the CCP-A1 migration's exact-matrix check is scoped to A1's own scope set (edited in place; nothing deployed), so a successor grant does not make it refuse.
- **TD-A8-3 implemented:** ineligibility is the refusal `SUPPORT_EXTENSION_INELIGIBLE` with one `SUPPORT_EXTENSION_REFUSED_INELIGIBLE` audit row; the generic create no longer accepts an EXTEND (bypass closed).
- **TD-A7-5 implemented:** D3 alert `ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION` (migration `20261028050000_ccp_r3_entitlement_alert`), one rule shared with the C6 report (`residual_authority`). No automatic revoke.
- **TD-R3-1 (Lead / PO decision request):** the capacity (upload) reserve of an OPEN, non-sending row (PAST_DUE past grace, INCOMPLETE) is still admitted, as the CCP-A4 Sign golden pins. Refusing it would change live Sign behaviour; not built.
- **DR-C2-3 conditions proven** (C2-R3-1…3); no gap. **TD-B2-1:** `plan_version_id_required`; UI "Retire this version"; DV-R3-1. **TD-D3-9:** R3-D39-1 (no sweep).
- **TD-C4-7 (Lead) designed in:** one shared redaction `withholdChangeRequestAmounts` / `withholdAuditPayloadAmounts`, keyed on `MONETARY_ACTION_TYPES` = CREDIT, DISCOUNT, REFUND (REFUND arrives with C4), serves the A3 list / detail / mutations, the A2 audit read and the B5 export. **D-R3-7:** DISCOUNT `discount_bps` is read as not monetary and stays visible.
- **TD-MERGE-37 (R3, after R1):** `wip/ccp-r3` (`f6bffc48`, on `41a0e3b5`) merged. The only conflict was `doc/ccp/decisions.md` (R3's acceptance reconciliation section appended).
  - **R1 × R3:** R3 was built before R1, and two `TenantEntitlement` fixture inserts in `ccp-r3-acceptance.integration.spec.ts` (lines 72 and 199) named no `granted_source`. R1's source scan (R1-U-1) flagged them, and R3-A75-1…5 failed on the NOT NULL. Both inserts now name `PROVISIONING` (2 sites). Result: R1 scan 4 / 4, R3 16 / 16.
  - **Scope pins** (25 scopes / 206 / 987) are asserted by the identity suite, which passes in full: 961 / 961.
  - **Intermittent (investigated, recorded, not called green):** in the full platform-admin CCP run under host load 28–41, `ccp-b4-commercial-contract-authorization.spec.ts` › "404 NOT_FOUND … 400 for a malformed id or query" failed once. The status was the expected 400, but the response body carried no `error.code`. The file then passed 13 / 13 three times in a row (load falling 16 → 3). It could not be reproduced. Nest's own logs from the same run show the opt-in D1 / D3 workers ticking inside other test apps of the same process, so environment bleed between files under load is the working hypothesis. It stays on the watch list for the remaining merges of this train.
- **TD-MERGE-38 (D5):** `wip/ccp-d5` (runbooks, docs only) merged with no source conflict (generated repo map regenerated). The `--until` stop point and expected counts in `RUNBOOK-ccp-migration-validation.md` are updated to the integrated chain at the end of this train (after FIX1), not here.
- **TD-MERGE-39 (D4):** `wip/ccp-d4` (test-only suites and the Playwright `journeys` project) merged with no source conflict (generated repo map regenerated).
  - **R1 × D4:** `apps/platform-admin/src/tests/support/ccp-d4-scenarios.ts` `entitle()` inserted `TenantEntitlement` without `granted_source`; it now names `PROVISIONING` (1 site). Before the fix, 10 of 15 negative-control tests failed on the NOT NULL in each of 3 runs.
  - **The negative-control suite is NOT green: intermittent.** Runs after the fix, host load 3–9: 14 / 15, 14 / 15, 14 / 15, 14 / 15, 15 / 15. Each failing run fails a DIFFERENT test (D4-GATE-1, D4-CREATE-1, D4-NC3 …) on one HTTP request that never answers: a 60 s supertest timeout or "socket hang up", on POST change-requests, POST policy-versions, or POST …/apply.
  - **Investigation.** The harness's 60 s hang dump was widened (test-only diagnostics, kept). At the failing request it shows no non-idle database session, no waiting lock, ZERO sessions of any state on the test database, and 0 open sockets on the app's HTTP server. So the request is not blocked in Postgres. It stalls or is dropped inside the app before any database work, and the server then closes the socket. No production code path was found to cause it; the cause is not identified.
  - **Hypotheses to check next:**
    - a client the harness leaves unset (`REDIS_URL` is deleted, so a Redis-backed module could queue a command forever);
    - Nest / supertest socket handling under the AppModule's opt-in workers.
  - Every negative control that ran asserted correctly (no control passed when it should refuse).
  - Playwright `journeys`: 39 / 39.
- **TD-MERGE-40 (D2, after R3):** `wip/ccp-d2` (`c9bf90e8`) merged. The only conflict was the generated repo map (regenerated).
  - **Finance amount scope switch (Lead, after R3).** D2 was built under the FA-6 interim: every amount withheld for every caller with `FINANCE_SCOPE_PENDING`. It now applies R3's LOCKED rule through `apps/platform-admin/src/app/platform/finance-amount-access.ts` (`amountAccess`).
    - Holders of `platform:billing:read` AND `platform:billing:amount:read` (platform_owner, finance_admin, read_only_auditor) receive `mrr_minor` / `arr_minor` on the report and each product line, and `mrr_minor` on each renewal bucket.
    - commercial_ops and support_admin receive the counts with `amount_withheld: "FINANCE_SCOPE_REQUIRED"`, the amount fields omitted.
    - The route is not refused for a non-holder: it also serves counts, and FA-5's 403 is for routes that exist only to serve amounts.
    - `FINANCE_SCOPE_PENDING` is removed from `@aramo/subscription`.
    - Updated: the DTO, controller and module comment; `ccp-d2-revenue-authorization.spec.ts` (3 holders with exact amounts, 2 non-holders with no amount anywhere, D2-R-0b scope matrix, D2-R-1b non-holder body = holder body minus amounts plus marker; 18 / 18); the OpenAPI schema; and the platform-web Pact (finance_admin holder + commercial_ops non-holder interactions).
  - **OpenAPI duplicate key (silent auto-merge collision).** R3 and D2 each added a `components.schemas.FinanceAmountWithheld` (`[FINANCE_SCOPE_REQUIRED]` vs `[FINANCE_SCOPE_PENDING]`). Git merged both without conflict. D2's copy is removed; a strict YAML parse (`uniqueKeys`) reports 0 errors.
  - **B4 × D2.** B4-N3-c's static scan (no source outside the contract module reads the contract tables) flagged `billing-revenue-report.service.ts`. It reads only whether a contract is linked to an open row, to EXCLUDE that row from list-price MRR (`CONTRACT_PRICED`). It never takes a plan, allowance or status from the contract. Allowlisted with that reason, the same nature as TD-MERGE-35.
  - **W-1 interaction (flagged for the Architect, not changed).** D2's MRR basis is `OPEN_SUBSCRIPTIONS_X_PINNED_LIST_PRICE`: an aggregate derived from published list prices, with contract-priced rows excluded and the basis named in every response. The W-1 ruling of 2026-10-25 says "never derive effective billing amounts from list prices". The Architect should confirm whether a labelled list-price MRR basis is in scope of W-1.
  - **D4 intermittent: cause found and fixed (test harness).** The hang dumps (no DB session, no socket left, a hang up at 30–60 s) pointed to a request not fully received by the server. Neither the D4 harness nor the C2 conversion-routes spec bound a port, so supertest opened and closed an ephemeral listener per request. In this merge's full run the hang hit `ccp-c2-conversion-routes` C2-RI-1 and D4-NC4. One rerun of the two files hit D4-GATE-1 at 62 s.
    - **Fix (test-only, behaviour-neutral):** `await app.listen(0, '127.0.0.1')` after `app.init()` in `support/ccp-d4-harness.ts` and in `ccp-c2-conversion-routes.integration.spec.ts`.
    - **After the fix:** negative controls 15 / 15 in 5 consecutive runs (host load 3–7), versus 1 clean run in 5 before.
    - The full platform-admin CCP suite then passed 701 / 701.
    - The B4 contract-authorization blip of TD-MERGE-37 (400 without `error.code`) is a different signature and stays on the watch list.

## PO decision (2026-10-25): Enterprise invoicing
**Enterprise invoicing: CCP records payment only.** The accounting integration is out of CCP scope. CCP will offer a manual, governed "record payment received" step: an enterprise contract's subscription activates only after payment is recorded, with evidence. That requires an action-catalog amendment, not yet drafted or LOCKED, so nothing is built until it is. An independent accounting service (program "ACCT": QuickBooks/Xero, serving both Aramo enterprise billing and tenant placement invoicing, with its own contract like Talent Intelligence and auth-service) is a separate program. Its integration with CCP is revisited once it exists. `invoicing.enabled: false` stays.

## Architect ratification: PAYMENT_RECORD A2 + Charter A2 (2026-10-25)

### LOCKED and filed (sidecars verified)
| Instrument | SHA-256 |
|---|---|
| `Aramo-CCP-Charter-Amendment-A2-Refund-Execution-Policy-Keys-v1_0-LOCKED.md` | `800c89c3d9e661baec5807005fc214d0b8af187824102f304573ac5656e20e40` |
| `Aramo-CCP-A1-Amendment-A2-Payment-Request-Scope-v1_0-LOCKED.md` | `20941cccf1f63cd37cea5819f94171d501ec43d5a8fb6f65787352f60a9b3d42` |
| `Aramo-CCP-Program-Build-Directive-Amendment-A2-Payment-Record-v1_0-LOCKED.md` | `4409e3a146730e2a642921ebae736e164145bf637ada3357aa838cd2915b304a` |

### Charter A2
- **RX-D1 / RX-D2 / RX-D3: approved.**
  - **The dual gate:** gate 1 is the operational switch `CCP_REFUND_EXECUTION_ENABLED` (refusal `REFUND_EXECUTION_NOT_RELEASED`); gate 2 is an ACTIVE policy with `refund_execution_enabled`, `refund_policy_ref` and `refund_policy_sha256` (refusal `REFUND_POLICY_NOT_APPROVED`).
  - **Where it's checked:** at the initial apply, and immediately before the first dispatch or a permitted re-arm.
  - **Snapshot vs ACTIVE:** both must carry the same refund-policy IDENTITY (ref and sha). Full policy checksums need not match.
  - **Reconciliation, webhooks, recording a confirmed refund and terminal recovery** never depend on either gate.
  - The keys are all present or all absent; missing or malformed fails closed.
  - **PO D5 confirmation** of the new keys is pending; refunds stay disabled regardless.

### PAYMENT_RECORD A2
- **K-1:** record the INITIAL payment before SUBSCRIPTION_OPEN. No apply-deadline exemption.
- **K-2:** resolved by §4.
  - `CommercialPaymentReceipt` is anchored by a FK to its governing change request, linked by FK to `Contract` and `ContractPaymentObligation` inside the SUBSCRIPTION_OPEN apply transaction.
  - The provisional identity is (tenant, product, `provisional_contract_ref`, INITIAL), with the ref unique and checked against existing contracts.
  - **N-3 is not relaxed:** the contract FK to its subscription is kept, and no temporary subscription is invented.
  - An unlinked receipt never auto-expires; it's listed and alerted, and neutralized only by CORRECT.
- **K-3:** `platform:payment:request` for commercial_ops and finance_admin, giving 25 / 207 / 989.
- **K-4:** Q14 with no exemption.
- **Payment methods:** BANK_TRANSFER, CHEQUE, CARD_EXTERNAL, OTHER. OTHER requires an explanation.
- **Grace:** absent `grace_days` means 0. Due-date boundaries are calendar dates in the contract's IANA timezone: due 2026-10-25 with g=0 is DUE on the 25th and PAST_DUE from the 26th.
- **POSTPAID** needs an explicit immutable `postpaid_approval` marker; it is never inferred.
- **The Platform Owner fallback** is resolved once at creation and snapshotted, never chosen later.

### Implementation
Authorized after the LOCK, on this branch, through the single writer:
- **C8-PR** (PAYMENT_RECORD);
- **the dual-gate remediation** (C4-P successor).

They start after the current merge train. Refunds stay disabled, invoicing stays disabled, and ACCT is out of CCP.

## Architect rulings: CCP-UI v1.2 Finance visibility (2026-10-25)

### The v1.2 baseline
CCP-UI v1.2 (`ccp/CCP-UI-v1_2/`, manifest 5/5, v1.0 and v1.1 unchanged) is APPROVED as the implementation baseline for the new Finance/Ops screens and the v1.0 amendments AM-1…AM-10, subject to W-1…W-3. A design amendment 1 is requested; the manifest gets re-verified after it.

### W-1: RATIFIED
- A published plan-version list price is catalog information. It is visible under catalog read, including beside a tenant's pinned version.
- Negotiated or contracted rates, discounts, effective tenant prices and invoice amounts require `platform:billing:amount:read`.
- Never derive effective billing amounts from list prices.

### W-2: RATIFIED
For an actor without `platform:billing:amount:read`, the whole free-text `Contract.terms` (and the `ContractAmendment.terms`) is redacted at the backend projection boundary, never only in the UI. The stored terms are unchanged.

### W-3: RATIFIED, with a restricted requester exception
- **Scope:** CREDIT, DISCOUNT, REFUND and PAYMENT_RECORD only.
- **Non-holder, non-requester:** reason, notes and evidence redacted.
- **The original requester:** sees their own submitted content. Provenance is established, because `CommercialChangeRequest.reason` and the payload evidence are requester-authored and immutable at create, while approver comments live in separate `CommercialApproval` rows.
- **Always scope-protected:** approval notes, provider amounts and internal annotations.
- **If provenance cannot be separated reliably,** fail closed.
- **Non-financial request reasons:** never redacted globally.

### Implementation
"R3-W": an extension of R3's shared redaction to the Contract and ChangeRequest projections, the exports, alerts and alternate read paths, with per-role tests (including commercial_ops viewing its own financial request). It follows the v1.2 screen build on the stable integrated HEAD after the merge train.
- **TD-MERGE-41 (C5):** `wip/ccp-c5` (`da47a9d4`) merged.
  - **Conflicts, all R3 × C5 on the same response objects.** Both sets of fields are kept: the C3 billing-status DTO, mapper, OpenAPI `TenantBillingStatusResponse` and authorization spec (R3's `payment_due` / `payment_overdue` / optional `invoices` + C5's required `tax`), the C6 outstanding-payments route (R3's per-caller `outstandingItemDto` + C5's `tax`), `@aramo/subscription` index exports and the platform-web Pact. R3's non-holder billing-status interaction (support_admin) now carries `tax` too.
  - **D2 × C5.** The D2 revenue route (built in parallel, not in C5's list) is a billing read, so it now carries the same designed disabled state, `tax: taxAvailability()` (DTO, OpenAPI `FinanceRevenueReport.tax` required, D2 spec, Pact).
  - **C5's no-tax-call guard** (C5-G-3 enumerates provider methods from the adapter prototypes) passes here. It is re-verified after C7 (cancel) and C4 (adjustment methods, C4-P `readPaymentPicture`) land.
  - `STRIPE_AUTOMATIC_TAX` remains named only in `.env.prod.example`'s removal note and in the pre-existing `doc/runbooks/RELEASE-sign-naming.md` env list (main-branch doc; untouched). Deploy note: remove the key from the prod `.env` when this ships.
  - **The supertest hang is not D4-specific.** In this merge's full platform-admin run the mocked, DB-free `ccp-b3-subscriptions-authorization.spec.ts` hung for 120 s on 7 consecutive tests: once the server wedged, every later request in the file stalled. Alone, it passed 12 / 12 three times.
    - **Cause (consistent with every dump so far):** a spec that never binds a port lets supertest call `listen(0)` and `close()` on the same `http.Server` for every request. Under host load, a new listen can race the previous close.
    - **Fix (test-only, behaviour-neutral):** extended TD-MERGE-40's `await app.listen(0, '127.0.0.1')` after `app.init()` to all 21 remaining platform-admin CCP spec files that use `request(app.getHttpServer())`. 23 files in total now bind one port.
    - **Result:** platform-admin CCP 701 / 701 at host load 7–15, where the same run took 885 s with 7 failures before.
- **TD-MERGE-42 (C7):** `wip/ccp-c7` (`1b41f78c`) merged.
  - **Conflicts:** the generated repo map (regenerated) and `subscription.module.ts` exports (D2's `BillingRevenueReportService` + C7's `SelfServiceBillingService`, both kept).
  - **Migration `20261028030000_ccp_c7_self_service_commands`** re-creates `guard_billing_provider_command()` as the C1 body + C7 block, makes `BillingProviderCommand.change_request_id` nullable and adds `self_service_request_id` (exactly one origin). Here it is the last writer of that function, and HEAD has no other block in it yet. C4 adds one, so the command-guard union is built at the C4 merge (TD-MERGE-CMDGUARD-1).
  - **Amounts (Lead check):** C7 adds no monetary field. The platform reads gain only the nullable `change_request_id` / `self_service_request_id`. The Sign self-service routes return state, refs and refusals; the upgrade is refused `financial_treatment_undefined` before any price is read. No finance-scope change is needed.
  - **Nullable `change_request_id` across later slices:** tsc is clean for all 5 projects, and every consumer that reads it (D3 alerts, R3, D2, C6 held activations, the conversion ledger) compiles and passes.
  - **C5 no-tax-call guard** with C7 in: `ccp-c5-tax-disabled.spec.ts` 15 / 15. C7 issues its cancel through the existing `SUBSCRIPTION_CANCEL` provider method, so the prototype enumeration (C5-G-3) covers it.
  - R1 granted_source scan 4 / 4.
- **TD-MERGE-43 (C4 tip = C4 + C4-R + C4-P, `c79e9c90`):** `wip/ccp-c4` merged.
  - **Conflicts resolved, both sides kept:**
    - `platform.module.ts` controllers (union);
    - `subscription.module.ts` (C7 `SelfServiceBillingService` + C4 adjustment port, ledger, `RefundRemainderGate`, refund report);
    - `schema.prisma`: C7's `@@unique([self_service_request_id, step])` + C4's `@@index([provider, provider_object_ref])`, and C7's `SelfServiceBillingRequest` + C4's `CommercialBillingAdjustment` (suffix trap: both models closed);
    - `commercial-change-request.service.ts`: R3's `SUPPORT_EXTENSION_INELIGIBLE` + C4-P's `REFUND_NOT_REFUNDABLE`; R3's payload `reason` + C4-P's `codes`;
    - the change-request controller error map (both cases);
    - OpenAPI `CommercialActionType` (R3's description + `REFUND`);
    - the platform-web Pact (coverage 35 routes; D2 `REVENUE` + C4-P `REFUND_REPORT`);
    - the e2e fixture (R3's per-persona withholding + C4's `applying`).
  - **`billing-command.service.ts` (C7 × C4, semantic merge).** C7 refactored the enqueue into `changeRequestOrigin` / `selfServiceOrigin`; C4 added the per-action kind check and canonical-JSON replay. C4's kind check (`BILLING_COMMAND_KINDS_BY_ACTION`, the DB mirror) now lives in `changeRequestOrigin`. The replay compares `canonicalJson`. `assertTargetOwned` takes both C4's `params` and C7's `allowHeld`. With C7's change request now nullable, the C4 dispatcher (`performAdjustment`) and the adjustment ledger refuse / ignore a command without one; only C7 cancels have none.
  - **TD-MERGE-CMDGUARD-1: command-guard union.** C1 (`20261026020000`), C4 (`20261028010000`) and C7 (`20261028030000`) each re-create `guard_billing_provider_command()`. Applied in order, C7's body silently dropped the C4 block, so CREDIT / DISCOUNT / REFUND commands could not be inserted and the per-action kind pin was gone.
    - **Fix:** the integrator-owned `20261029000000_ccp_command_guard_union` (sorts after C7) re-creates it as the C1 body + the labelled C7 and C4 blocks, verbatim. It is a 3-way `git merge-file` of the C4 and C7 bodies over C1, with 0 conflicts.
    - **C4-R:** its fence (command state, attempts, `updated_at`) is app-side. Its DB needs are the C4 body, which the union carries unchanged.
    - **Probe spec** `ccp-command-guard-union.integration.spec.ts`, 5 / 5:
      - CMDGUARD-1: INSERT, 15 action types × 7 kinds = 105 probes; admitted exactly the 7 `BILLING_COMMAND_KINDS_BY_ACTION` pairs.
      - CMDGUARD-2: self-service origin admits only SUBSCRIPTION_CANCEL AT_PERIOD_END; none / both origins refused.
      - CMDGUARD-3: UPDATE, 6 × 6 = `canTransitionBillingCommand`.
      - CMDGUARD-4: the live body = the union file's.
      - CMDGUARD-5: the compensation.
    - **Compensating SQL:** `fixtures/ccp-command-guard-union-compensating.sql` restores C7's body verbatim. It is refused while a C4 command is unconfirmed.
    - **C7's own compensation now restores C4's body,** not C1's: on the integrated chain C4 precedes C7. C7-COMP-2 follows that reverse order: union compensation, then C7 compensation, then re-apply C7 + union.
  - **Change-request guard / constraint unions.** C4's branch already folded its labelled blocks into `20261027000000_ccp_guard_union` (CCP-C4 apply pairs + attempt / APPLIED checks; CCP-C4-R REFUND APPLYING → WITHDRAWN with `withdrawn_at`, no in-flight / confirmed command, and its audit event) and into `20261027000100_ccp_constraint_union` (`REFUND` in `CommercialChangeRequest_action_type_check`; the 5 adjustment kinds in `BillingProviderCommand_kind_check`). HEAD had not touched either file since C4's base, so they merged cleanly. `canTransitionFor` is mirrored and GUARD-UNION-1…4 pass with REFUND.
    - **CHECK lists:** `CommercialChangeRequest` = the 15 `COMMERCIAL_ACTION_TYPES`; `BillingProviderCommand_kind` = the 7 `BILLING_COMMAND_KINDS`; `CommercialChangeApplication` = A6 + A7 + A8 + C2 (C4 writes `CommercialBillingAdjustment`, not an application).
    - C7 changes only the origin and idempotency CHECKs, which no other slice redefines.
  - **Finance scope switch (C4 × R3).** The C4 interim (`FINANCE_SCOPE_PENDING` for every caller, `withholdAmounts` / `AMOUNT_WITHHELD_MARKER`) is removed. The billing-adjustment routes (apply, read, resolve), the C1 billing-commands list and the C2 conversion read now use `amountAccess(auth)`:
    - the request payload and chain basis use R3's `withholdChangeRequestAmounts` (MONETARY_ACTION_TYPES includes REFUND);
    - command params use a new shared `withholdMonetaryAmounts` (any kind, fail closed);
    - the adjustment record shows `amount_minor` / `currency` to a holder, else `amount_withheld: FINANCE_SCOPE_REQUIRED`.
    - Policy thresholds stay visible, per R3 / FA-3. C4's interim had hidden `credit_escalation_threshold_minor`.
    - **Tests:** C4-U-7 rewritten (REFUND identity fields stay, amount withheld; holder copy unchanged); C4-RI-1 / RI-3 / RI-5 and the billing-commands read: holder vs non-holder; OpenAPI (3 descriptions; the record's `amount_withheld` now refs R3's `FinanceAmountWithheld`); Pact (commercial_ops interactions get the marker; the read_only_auditor read shows the amount).
  - **REFUND redaction coverage confirmed:**
    - payload / basis / refund identity (`provider_invoice_ref`, `provider_payment_ref`, category, `refund_policy_ref` stay, amount withheld);
    - the `COMMERCIAL_REFUND_*` audit bodies, which carry `action_type`, so R3's `withholdAuditPayloadAmounts` applies; C4 writes no amount into them anyway;
    - C4-P's refusal details (`REFUND_EXCEEDS_REMAINDER` carries `remainder_known` only).
  - **D3 alert payloads (FA-6):** the command alerts carry state, kind, refs, attempts and an error code. They carry no params and no amount.
  - **Residual for R3-W:** `REFUND_REMAINDER_UNVERIFIABLE` with basis `provider_read_failed` passes up to 200 characters of the provider error text in 409 details. A non-holder requester receives it. Provider read errors are not expected to quote amounts, but this alternate path is not redacted. Flagged for the R3-W extension.
  - **TD-C4P-6:** the refund report controller uses R3's `amountAccess` (both scopes). C4-P's local `canReadFinanceAmounts` (amount scope only) and its duplicate `FINANCE_AMOUNT_SCOPE` export are removed. C4P-RI-1 runs against the integrated bundles, which carry the seeded grant (the `+amount` test principals are gone): platform_owner, finance_admin and read_only_auditor see `amount_minor`; commercial_ops and support_admin get the marker. Pact has a finance_admin holder interaction and a support_admin non-holder interaction.
  - **TD-MERGE "RF-4 satisfied by C4-P (implements AC-2 / RF-4)":** not re-implemented.
    - C4P-1…9 and C4P-U-1…4 pass on the integrated branch.
    - RF-5 binding is verified through `REFUND_PAYMENT_MISMATCH` (invoice / paying account / payment) in C4P-3 and the gate tests.
  - **TD-C4R-5:**
    1. Added the direct C7 assertion to C4R-7. After the approved manual CREDIT on a committed self-service row, C7's owner cancel is refused `FINANCIAL_TREATMENT_UNDEFINED` with `COMMITMENT_TERM_DETAIL`, writes no request or command, and leaves the row byte-identical. It is asserted before C2's conversion opens, because an open CONVERSION refuses C7 first with `CONVERSION_IN_PROGRESS`.
    2. The `commercial-apply-records.ts` reconciliation happens at ACC-1. C4 only adds explanations.
    3. Done (command-guard union).
    4. Re-checked at ACC-1.
  - **C5 × C4 / C4-P.** C5-G-3's prototype enumeration found C4's `executeAdjustment`, `readAdjustmentEffect` and C4-P's `readPaymentPicture`. All three are now exercised on every operation in C5-G-4: recorded requests 14 → 36, refund / coupon / dispute / refund-list requests asserted present, none carrying a tax token. C7's cancel uses the existing `cancelSubscription`. 15 / 15.
  - **TD-C4-21:** both e2e lint errors fixed (trivial, behaviour-neutral). Recorded with baseline evidence in `doc/ccp/known-baseline-exceptions.md`, together with the 2 Template Studio visual failures (not re-captured).
  - **Supertest port binding:** the new C4 route spec now binds a port too (TD-MERGE-41).
- **TD-MERGE-44 (ACC-1b, `c37b28aa`):** `wip/ccp-acc1b` merged.
  - **Conflicts, both sides kept:**
    - the change-request controller error map (R3 + C4-P cases + ACC-1's `REQUESTER_NO_LONGER_AUTHORIZED` / `APPLY_EXPIRED` / `APPLY_IN_PROGRESS` / `APPLY_UNRESOLVED` / `ALREADY_APPLIED`; no duplicate case);
    - the service error-code union;
    - `20261027000000_ccp_guard_union`: header notes, and the transition list with the labelled CCP-C4, CCP-C4-R and CCP-ACC-1 blocks side by side; ACC-1's withdrawal-record check block merged clean;
    - `ccp-a9-role-change.spec.ts` (C4-R's REFUND resolution + ACC-1's POLICY_ACTIVATE withdrawal in the mirror-table expectation).
  - **ACC-U-1 × C4-R.** ACC-U-1 asserted "no action withdraws from APPLYING", which predates C4-R. REFUND APPLYING → WITHDRAWN is C4-R's governed resolution (Architect C4 disposition, TD-C4-12), so the assertion now exempts REFUND only. Every other action still never withdraws from APPLYING. 14 / 14.
  - **TD-C4R-5 (2): one APPLY_FAILED helper.** ACC-1 split `commercial-apply-records.ts` into `recordApplyFailureInTx` (inside the caller's transaction, after its savepoint) + `recordApplyFailure` (own transaction: billing lock, request lock, then the in-transaction record). C4 carried a private copy of the same steps (`CommercialBillingAdjustmentService.recordFailure`). It now delegates to `recordApplyFailure`, keeping both behaviours:
    - C4: billing lock + request lock, APPROVED / APPLY_FAILED → APPLYING (+1) → APPLY_FAILED, one audit row, UNRECORDED if unwritable;
    - ACC-1: the in-transaction record and `evidence_when_unchanged`.
    - The C4 audit row now also carries the shared `explanation`.
  - **TD-C4R-5 (4) / TD-C4R-1:** ACC-1's savepoint is confined to the policy apply. The Stripe read/write fence (command state, attempts, `updated_at`) in `billing-command.service.ts` is untouched, and C4R-1…7 and C4-RACE / C4-TX pass on the integrated branch.
  - **Specs the Lead named, on the integrated branch:** ACC-1 (`ccp-acc1-policy-withdraw`), B5-R, B5 governance, and GUARD-UNION-1…4 (probes cover the ACC-1 pair and REFUND) all pass inside the suite counts below. The platform-admin provider passes 2 / 2. The platform-governance consumer, verified by verify-api, passes 1 / 1.
- **TD-MERGE-45 (FIX1, `7a9d375d`):** `wip/ccp-fix1` merged.
  - **Conflicts, both sides kept:**
    - `ccp-b5-governance-routes.integration.spec.ts`: ACC-1-RI and FIX1-RI-APPLY-TTL, two tests (suffix trap: both closed);
    - the D3 alert specs (D3-U-1 and the metrics keys);
    - OpenAPI `CommercialAlert.alert_type`: R3's description + all 11 types.
  - **TD-MERGE-ALERT-1: alert-type union.** `CommercialOperationalAlert_type_check` is written by D3 (`20261026090000`; FIX1 added its 2 apply-deadline types there in place, giving 10) and re-asserted by R3 (`20261028050000`, the 8 D3 types + `ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION` = 9). Applied in order, R3's re-assertion silently dropped FIX1's two types, and the scanner's APPLY_DEADLINE_* raises would have failed the CHECK.
    - **Fix:** the integrator-owned `20261029000100_ccp_alert_type_union` (sorts last) re-asserts the union: 11 labelled triples in the order of `COMMERCIAL_ALERT_DEFINITIONS` (D3 8 + R3 1 + FIX1 2).
    - **Compensation:** `fixtures/ccp-alert-type-union-compensating.sql` restores R3's 9 and is refused while an apply-deadline row exists.
    - **D3-U-1** now reads the union file and pins 11 types; the D3 metric keys carry R3's billing type and FIX1's two approval types.
  - **Watch-out 1: full compensation chain extended 21 → 27.** `ccp-full-compensation-chain.integration.spec.ts` gains:
    - C4 `20261028010000`;
    - C7 `20261028030000`;
    - R3 alert `20261028050000`, with new `fixtures/ccp-r3-alert-compensating.sql`: refused while an ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION row exists; re-asserts D3's CHECK as edited by FIX1;
    - R3 identity A1-A1 `20261028060000`: data only, checked by catalog rows 16 / 48 → 15 / 45;
    - the command-guard union `20261029000000`;
    - the alert-type union `20261029000100`.

    Each new step is refused while its dependent data exists (nothing changed), then compensates with 0 errors to the exact pre-migration fingerprint, and all 27 re-apply. Result: 30 / 30. R1's in-place A7 edit is covered by the existing A7 steps (fingerprints equal both ways). C4-P adds no migration.
  - **Watch-out 2:** the alert types are unioned to 11 (above). The D3 metric keys and D3-U-1 reflect 11. The constraint-union file sorts before R3, so it could not hold the CHECK, hence the separate integrator file.
  - **Watch-out 3: FIX1 policy draft editor × ACC-1.** They merged without conflict:
    - FIX1 adds `apply_expiry_hours` to `POLICY_EDITABLE_KEYS`, records optional keys in the edit audit, and adds the PolicyView field;
    - ACC-1 adds `open_request.withdraw_actionable` and the withdraw route.
    - They touch different functions. B5 governance (unit + routes) and platform-web governance specs pass, and the platform-governance consumer is verified by verify-api.
  - **Watch-out 4: D5 runbook** `RUNBOOK-ccp-migration-validation.md` brought to the integrated chain:
    - 27 migrations, every one with its SQL compensation file;
    - `--until 20261029000100_ccp_alert_type_union` and gate `27 applied`;
    - Q1 + 6 / + 16 / + 48 (25 / 210 / 1021 from production's 19 / 194 / 973);
    - Q7 `union_blocks = 28`; Q8 6 APPLYING backstops; Q9 + billing adjustments and self-service requests = 0;
    - new Q11 (command-guard markers 3, alert types 11);
    - §6 reverse order 27 → 1, all executable, with refusal conditions.
  - **D4 on the final head** (after the TD-MERGE-40/41 port binding), host load 4–7:
    - negative controls 15 / 15, 15 / 15, 15 / 15;
    - A1 role matrix + tenant isolation 116 / 116;
    - Playwright journeys + keyboard 73 / 73 (at the C4 merge).
  - **Final checks across the train:**
    - scope pins 25 / 206 / 987: identity suite 961 / 961;
    - the CHECK lists of both unions and the new alert union: as recorded in TD-MERGE-43 and above;
    - R3's leak tests (A2 / A3 / C3 / C6 authorization, R3 acceptance) re-run green after D2, C7 and C4, inside the platform-admin and subscription suite counts of each merge.

## R-SYNC (2026-10-25): origin/main `ac24e234` into the program branch at `5edabc0f`
- **TD-MERGE-46.** `origin/main` (9 commits since the program base `78dbd6d3`, ending with PR #1010, Aramo Sign mobile) was merged `--no-ff`.
  - **Conflicts:**
    - `package.json` `pact:consumer`: main's `sign-mobile` consumer + the branch's `platform-web-consumer`;
    - `sender-console.consumer.test.ts` header list: CCP items 10–13 kept, main's mobile items renumbered 14–17;
    - `verify-sign.ts`: the CCP `billingOwnerJwt` + main's `nativeJwt`, both kept, with the shared suffix duplicated;
    - the generated repo map (regenerated).
  - **Migration interleaving.** main's 5 migrations against the 27 CCP migrations, global sort order:

    | Main migration | Sorts between | Objects touched | CCP objects touched |
    |---|---|---|---|
    | `auth-storage/20261025120000_native_device_sessions` | CCP-A2 `20261024180000` … CCP-A3 `20261025120000` (name tie-break: `auth-storage` < `subscription`) | `auth_storage` native device sessions + redeemed-code ledger | none |
    | `sign/20261026100000_sign_mobile_notifications` | CCP-D3 `20261026090000` … guard union `20261027000000` | `sign` schema | none |
    | `sign/20261026100100_sign_mobile_envelope_contracts` | same | `sign` schema | none |
    | `sign/20261026100200_sign_mobile_page_sizes` | same | `sign` schema | none |
    | `sign/20261026100300_sign_mobile_draft_delete` | same | `sign` schema | none |

    - None of the 5 sorts after an integrator union file.
    - None references the subscription, identity or entitlement schemas, a CCP CHECK or a CCP function.
    - The 4 integrator unions (`20261027000000`, `20261027000100`, `20261029000000`, `20261029000100`) still sort last for their objects. No HALT condition.
    - The full compensation chain runs over the merged set: every lib migration, with main's 5 interleaved. All 27 CCP steps refuse, compensate and re-apply with 0 errors (inside subscription 826 / 826).
  - **Identity catalog:** main changes no identity migration or seed. Scope pins are unchanged at 25 / 206 / 987 (identity 961 / 961); delta 0.
  - **R1 × main (`granted_source`).** main's 3 new sign-mobile integration specs inserted `TenantEntitlement` without `granted_source`; R1-U-1 flagged them. Now `PROVISIONING` (3 sites).
  - **CCP-A4 / A5 × main.** 2 of those specs (contracts, sender drafts) inserted a `TenantSubscription` without `product_key` / `plan_version_id` / `composition_role`, so the whole suites failed. Their inserts now pin the PUBLISHED version, the plan's product key and BASE, the same fix earlier CCP merges applied to `sign-api.integration.spec.ts`. Result: sign-mobile specs 30 / 30.
  - **D5 runbook:** the stop point is unchanged (`20261029000100_ccp_alert_type_union` stays last). The note on main's 5 migrations and the gate count (27 + any of the 5 still pending, when separately authorized) are updated. Production `52ea8de6` predates them.
  - **`mobile/sign` (#1010):** its own gate contract passes on the merged tree: `npm ci`, `typecheck`, `lint`, and `test` 253 / 253 in 28 suites. The repo vocabulary script, which main extended for mobile, passes. Its `node_modules` stays untracked.

## Architect scope freeze and program closure directive (2026-10-25)

### The ruling
**CCP feature scope is FROZEN.** The objective is to complete and publish the already-authorized CCP.

### What may still be finished
- UI-V12, R3-W, C8-PR (the already-authorized slice, frozen after it) and DG;
- then D6, the program acceptance register and the final integrated gate;
- corrections strictly necessary to pass the existing acceptance and security gates.

### What is not authorized without a new explicit PO decision
- new action types, roles, scopes, workflows, dashboards or integrations;
- functionality-expanding amendments;
- convenience features.

### The 3 exceptions
1. a demonstrated security or tenant-isolation defect;
2. a demonstrated financial-integrity or unauthorized-commercial-effect defect;
3. a LOCKED obligation that is otherwise impossible to satisfy.

Each needs a bounded, evidence-based request before implementation, and the smallest defensible change.

### Classification of open findings
- **A, BLOCKING:** violates an existing acceptance, security or financial invariant. **Only A may be implemented.**
- **B, EXTERNAL:** needs Finance, Legal, Stripe, Tax or another external authority.
- **C, DEFERRED:** an optional improvement or an unsupported v1 feature.
- **D, RESOLVED:** the implementation and evidence already satisfy it.

### Interim directions
- **TD-R3-1:** keep the fail-closed send enforcement; no upload restriction (C).
- **TD-C5-1:** reconcile with the disabled tax configuration; no activation. The prod `.env` removal happens at deploy (B / ops).
- **TD-D2-1/2:** only authoritative inputs; contract-priced revenue excluded; no invented MRR (D, as built).
- **TD-D5-2:** privileged emergency access stays disabled unless a LOCKED requirement mandates it. The D5 break-glass runbook is documentation only (C).
- **W-1 vs D2:** a list-price-derived figure is never labelled actual MRR. If shown, it is "illustrative list-price value", never recognized revenue. This is the smallest correction: labels and field descriptions only (A, labelling).
- **Remaining R3/C4 findings:** only genuine authorization or financial-integrity discrepancies.
- **C7:** keep the legal fail-closed gate; defer the improvements (C).
- **GV-07:** separate from CCP.
- **Outside CCP:** PROD-SEC-1, website and app legal copy, GV-07, ACCT, legal drafting and Finance policy.

### Publication
HALT after the final engineering acceptance and return the single-PR publication request. Push, PR, merge, migration, deploy, bootstrap, backfill and activation are all NOT authorized.

### Integration queue (Lead, 2026-10-25)
- Merge order from `eefa795d`: DG (`wip/ccp-dg`; no guard-union change, no migration), then R3-W, C8-PR, UI-V12.
- **For D6:** Charter A2 dependency row 6 requires a release-checklist step that verifies the ACTIVE policy's `refund_policy_sha256` against the LOCKED refund-policy sidecar (RX-4). This is D6 checklist content, not a new feature; DG records it as G-2.

- **TD-MERGE-47 (W-1 vs D2, class A labelling; smallest correction).**
  - **Human-facing labels:** the D2 revenue figures are relabelled "illustrative list-price monthly value" and "… annualized" in:
    - the OpenAPI summary, description and field descriptions;
    - the DTO, controller and service comments;
    - the service-level text output `formatRevenueReport` (`illustrative list-price monthly value=… annualized=… recognized_revenue=false`).
  - **Contract:** the field names `mrr_minor` / `arr_minor` are kept (no contract churn), with descriptions that say they are not recognized revenue and not actual MRR / ARR.
    - The response already carried a list-price basis marker (`basis: OPEN_SUBSCRIPTIONS_X_PINNED_LIST_PRICE`), so it is kept, not replaced, and now has a description.
    - A new required `recognized_revenue: false` (OpenAPI `enum: [false]`) was added, with the DTO, controller, D2 spec (18 / 18) and the platform-web Pact interaction (pact regenerated, 196 / 196) updated.
    - The platform-admin provider passes 2 / 2.
  - **Gates:** D2 service specs 12 / 12; platform-web dashboard no-money specs 15 / 15. openapi-drift, contract-parity, orphan-scopes, env-passthrough, error-codes, tsc, lint, vocabulary and repo-map all pass (rc=0).
- **TD-MERGE-48 (DG, `d44f9df2`, refund dual gate per Charter Amendment A2):** `wip/ccp-dg` merged onto `30df7a36` with no conflict. DG adds no migration and does not touch the guard unions.
  - **Fix:** `tsc -p pact/provider` refused DG's new `{ setup, teardown }` provider state handler. Pact's runtime accepts that shape (StateFuncWithSetup), but the `stateHandlers` map is typed as plain state functions. The handler is now cast to the map's function type, which changes types only. The provider passes 2 / 2 before and after the cast.
  - **Integrated:**
    - subscription CCP 847 / 847 (includes the DG specs, both guard probes and the full compensation chain);
    - platform-admin CCP 712 / 712;
    - D4 negative controls 15 / 15 × 3 (host load 23–42);
    - platform-web unit 555 / 555;
    - platform-web consumer 199 / 199;
    - providers: platform-admin 2 / 2, verify-api 1 / 1 (platform-governance), verify-sign 1 / 1;
    - sign consumers 11 + 6 + 19;
    - sign-service 504 / 504;
    - R1 scan 4 / 4.
  - **Gates:** tsc (5), lint, contract-parity, openapi-drift, orphan-scopes, env-passthrough, error-codes, tests:integration, vocabulary and repo-map all pass (rc=0).
  - **For D6:** DG's G-2, the release-checklist step from Charter A2 dependency row 6 / RX-4 that verifies the ACTIVE policy's `refund_policy_sha256` against the LOCKED refund-policy sidecar, is carried into the D6 checklist.
- **TD-MERGE-49 (R3-W, `d8ab480d`; W-2 contract terms + W-3 financial request redaction):** `wip/ccp-r3w` merged with no source conflict. The generated repo map was regenerated. No migration; scope catalog unchanged at 25 / 206 / 987 (identity 961 / 961).
  - **R3-W's 3 new specs on the integrated head:**
    - `ccp-r3w-finance-visibility.spec.ts` (subscription) 20 / 20;
    - `ccp-r3w-finance-visibility-authorization.spec.ts` + `ccp-r3w-serializer-scan.spec.ts` (platform-admin) 75 / 75.
  - **Serializer scan × DG:** the scan passes with DG's refusal details in place. DG's gate detail (`refundGateDetail`) carries only `gate_1_released` and the `gate_2` basis code: no provider text, no policy content, no amount.
  - **Provider error text:** R3-W withholds it from non-holders in the billing-adjustment error path. This closes the TD-MERGE-43 residual (`REFUND_REMAINDER_UNVERIFIABLE` with basis `provider_read_failed`).
  - **R3-W gaps for the acceptance register:**
    - G-1 (C): the amendment `summary` is visible;
    - G-2 (C): the webhook inbox `last_error`;
    - G-3 (D): D2's list-price basis, resolved by TD-MERGE-47;
    - G-5 (C): `payload_checksum`.
  - **Integrated:**
    - subscription CCP 867 / 867;
    - platform-admin CCP 787 / 787;
    - D4 negative controls 15 / 15 × 3;
    - platform-web unit 555 / 555;
    - platform-web consumer 202 / 202;
    - providers: platform-admin 2 / 2, verify-api 1 / 1, verify-sign 1 / 1;
    - sign-service 504 / 504;
    - R1 scan 4 / 4.
  - **Gates:** tsc (5), lint, contract-parity, openapi-drift, orphan-scopes, env-passthrough, error-codes, tests:integration, vocabulary and repo-map all pass (rc=0).
- **TD-MERGE-50 (C8-PR, `746afa1a`; PAYMENT_RECORD per LOCKED Amendment A2):** `wip/ccp-c8pr` merged.
  - **Conflicts (R3-W × C8-PR):**
    - `requestDto` keeps R3-W's projection (`f.payload` from `projectChangeRequestFinance`). C8-PR's direct `withholdChangeRequestAmounts` line is superseded by it; the projection uses the same helper.
    - Change-request create keeps DG's single `policy` read, with C8-PR's `let chain`.
    - Repo map regenerated.
  - **One action-type list.** R3-W's `FINANCIAL_REQUEST_ACTION_TYPES` is now an alias of C8-PR's `MONETARY_ACTION_TYPES` (CREDIT, DISCOUNT, REFUND, PAYMENT_RECORD), never a second copy. W-3 therefore covers PAYMENT_RECORD's reason, notes and evidence, and R3's amount redaction covers its amounts.
  - **R3-W scans brought to the integrated head (classification only; no behaviour change):**
    - R3W-R-1: PAYMENT_RECORD is now one of the 16 action types; the 12 others are never masked.
    - R3W-SCAN-3: C8-PR's `platform-commercial-contract-payments.controller.ts` (`GET /platform/commercial/contracts/{id}/payments`) is classified. Its payment terms, amounts and receipt records (evidence included) go only to a Finance amount holder; others get statuses and the FA-4 booleans. 18 controllers, 45 handlers.
    - R3W-SCAN-5: 10 alert evidence objects. C8-PR's PAYMENT_RECEIPT_UNLINKED carries receipt id, refs and `recorded_at`: no amount, no evidence. The C6 `unlinked_receipts` rows carry the same, with no amount.
  - **Lint:** import order in `billing-finance-report.service.ts`.
  - **Union order (Lead watch-out 3):** `20261030010000_ccp_c8pr_payment_record` sorts after the integrator unions, but it creates only new objects (contract payment terms, obligations, receipts, their guards, one APPLYING backstop). It re-creates no union-owned function or CHECK. Its labelled CCP-C8-PR blocks are inside the guard, constraint and alert-type union files, which stay authoritative; no re-timing needed.
    - The guard-union probe now runs over 16 action types; the command-guard probe is unchanged (PAYMENT_RECORD issues no provider command).
    - The full compensation chain is 29 steps (C8-PR added A1-A2 and C8-PR); all pass.
  - **D5 runbook** updated:
    - 29 migrations; `--until 20261030010000_ccp_c8pr_payment_record`; gate `29 applied`;
    - Q1 + 6 / + 17 / + 50 (production 25 / 211 / 1023); Q7 `union_blocks = 30`; Q8 7 APPLYING backstops; Q9 + payment receipts / obligations = 0; Q11 alert types 12;
    - compensation order 29 → 1, renumbered newest first.
  - **Scope pins:** 25 / 207 / 989 (C8-PR's `platform:payment:request` for commercial_ops + finance_admin); identity 976 / 976.
  - **Integrated:**
    - subscription CCP 905 / 905;
    - platform-admin CCP 796 / 796 (R3-W per-role + scan 75 / 75);
    - D4 negative controls (now with PAYMENT_RECORD) 15 / 15 × 3;
    - entitlement 52 / 52;
    - auth-service 394 / 394;
    - sign-service 504 / 504;
    - platform-web unit 555 / 555;
    - all pacts deleted and regenerated (platform-web consumer 207 / 207) and all 5 providers 7 / 7;
    - R1 scan 4 / 4.
  - **Gates:** tsc, lint (9 projects), contract-parity, openapi-drift, orphan-scopes, env-passthrough, error-codes, tests:integration, vocabulary and repo-map all pass (rc=0).
