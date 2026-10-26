# CCP-B5 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` §6.2, the §5.3 B5 row and the common Phase B obligations. Recorded before the slice's first change.

| | |
|---|---|
| **Slice** | CCP-B5, commercial role management + audit explorer + the policy screen (B5-P), with the backend apply of `POLICY_ACTIVATE` (TD-A9-16) |
| **Worktree / branch** | `.claude/worktrees/ccp-b5`, branch `wip/ccp-b5` |
| **Baseline** | `b4a3f5f0a73d8d9caebfe612e2173077dbe8cdb4` ("CCP: record Architect ratification of TD-A5-1 …"). Drift since the cut: 0 commits. A6, B1, B2 and D1 are built in parallel in other worktrees; nothing from them is on this baseline. |
| **Governing text** | PBD §2, §5.3 (common Phase B set + the B5 row), §6, §7; PLATFORM-UX-1 Amendment A1, A1-2, A1-4 (R-1, R-2, R-3, R-5, R-12, R-13, R-18, R-19), A1-4a, A1-5; PLATFORM-UX-1 §3 (pixel parity); `doc/ccp/decisions.md` Q1, Q2, TD-A3-0 (NC-5 ratified), TD-A3-5, TD-A3-6, TD-A9-1, TD-A9-16, B5-P |
| **Authority hashes (re-verified)** | `shasum -a 256 -c` on the three `.sha256` sidecars: PBD, PLATFORM-UX-1 Amendment A1 and PLATFORM-UX-1 v1.0 — **3 / 3 OK** |

## 1. Prerequisites (B5 row: "A9, A2 evidence"; common Phase B set)

| Prerequisite | Evidence |
|---|---|
| A2 evidence | `doc/ccp/slices/CCP-A2-acceptance.md` (append-only `CommercialAuditEvent`; `CommercialPolicyVersion` v1 ACTIVE; `GET /platform/commercial/audit-events` under `platform:commercial:audit:read`) |
| A9 evidence | `doc/ccp/slices/CCP-A9-acceptance.md` (governed `ROLE_GRANT` / `ROLE_REVOKE` via `POST /platform/commercial/change-requests`; the narrow role apply; 409 `PLATFORM_LAST_OWNER`; `POLICY_ACTIVATE` requestable by `finance_admin`, approvable, **not applied** — TD-A9-16) |
| A3 evidence (chain, NC-5) | `doc/ccp/slices/CCP-A3-acceptance.md` (the seven refusals, `checkChainSatisfiable`, `assertChainStillSatisfiableAtApply`, NC-1…NC-5) |
| A10 evidence (Pact) | `doc/ccp/slices/CCP-A10-acceptance.md` §5 (how a slice extends the platform-web → platform-admin contract; the coverage gate) |
| Pinned design handoff (§2.5, A1-5) | §5 below |

## 2. `path:line` re-verified at the baseline

| Reference | Verified text / fact |
|---|---|
| `libs/subscription/prisma/migrations/20261025180100_ccp_a9_role_change_apply_bootstrap/migration.sql:68-69` | `OR (role_change AND OLD."state" = 'APPROVED' AND NEW."state" = 'APPLYING')` / `… 'APPLYING' AND NEW."state" = 'APPLIED'` — the only APPLYING / APPLIED transitions; `role_change` is `ROLE_GRANT` / `ROLE_REVOKE` only |
| `libs/subscription/src/lib/commercial/commercial-change-request.service.ts:516` | `// CCP-A9: a completed role change applies in its own transaction (TD-A9-1).` — the post-approval apply hook |
| `libs/subscription/src/lib/commercial/commercial-change-request.service.ts:609` | `if (action_type === 'POLICY_ACTIVATE') {` — the create-time target check (exists; not ACTIVE) |
| `libs/subscription/src/lib/commercial/commercial-change-request.ts:237`, `:331` | `POLICY_ACTIVATE` → `FINANCE_THEN_OWNER` (Q1); payload `policy_version_id` only |
| `libs/subscription/src/lib/commercial/commercial-policy.repository.ts:21` | "There is deliberately NO activation method" |
| `libs/subscription/prisma/migrations/20261024180000_ccp_a2_commercial_audit_policy/migration.sql:118` | `CommercialPolicyAuditEvent_event_type_check` closed to CREATED / ACTIVATED / RETIRED |
| same file `:170` | `CommercialAuditEvent_event_type_check` is a format check (`^[A-Z][A-Z0-9_]{2,99}$`), not a closed set |
| `apps/platform-admin/src/app/platform/platform-commercial-audit.controller.ts:24` | `@Get('audit-events')` — read only; no export route |
| `libs/subscription/src/tests/ccp-a9-bootstrap-role-change.integration.spec.ts:437` | `expect(done.apply).toBeNull();` (A9-POL-1 pins "not applied"; B5 re-points it) |
| `apps/platform-web/src/App.tsx:152` | `/admins` gated on `platform:admin:invite` (super_admin only) |
| `apps/platform-web/src/admins/PlatformAdminsView.tsx:89` | "The list of current platform admins isn't available yet." (R-13 data gap) |
| `apps/platform-web/src/shell/nav.ts:83` | the Platform admins rail item, scope `platform:admin:invite` (B1 owns the rail) |

## 3. Choices the schedule leaves to this record

| # | Choice | Decision | Confirmation needed |
|---|---|---|---|
| C-1 | **How POLICY_ACTIVATE is applied without replacing `guard_commercial_change_request()`** (lead: A6 is replacing it concurrently) | **Apply inside the transitions the guard already allows.** The guard admits no transition out of APPROVED for `POLICY_ACTIVATE`, and admits **no column change without a transition**, so the request row is not written at all by the apply. The apply runs in its own transaction right after the approval that completes the chain (the A9 C-2 timing): lock the request; integrity; idempotency (an existing `COMMERCIAL_CHANGE_REQUEST_APPLIED` event for this request → no-op); the NC-5 re-check of every signature (`assertChainStillSatisfiableAtApply`, live roster); the **NC-5 snapshot re-check** (below); then the policy write (ACTIVE → RETIRED, target → ACTIVE, both permitted by the A2 policy trigger), the policy audit rows and the commercial audit rows. The **request stays APPROVED**; its applied state is the `COMMERCIAL_CHANGE_REQUEST_APPLIED` audit event, exposed read-only on the request DTO as `policy_activation`. A refusal rolls back and writes one `COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED` event (A9 pattern). | **Lead:** the exact guard delta that would let the request itself reach APPLIED is reported (TD-B5-1) for coordination with A6; B5 ships **no** guard change and **no** migration. |
| C-2 | NC-5 snapshot re-check at apply (TD-A9-16; TD-A3-0) | Refuse, fail closed, no mutation, signatures untouched, when: (a) a signer lost eligibility (`APPROVER_NO_LONGER_ELIGIBLE`, reused); (b) the ACTIVE version is no longer the one the request was created under (`request.policy_version_id` / `policy_checksum`) → `POLICY_ACTIVE_CHANGED`; (c) the target's content checksum differs from the snapshot in the payload → `TARGET_CHANGED`; (d) the target is no longer DRAFT or RETIRED → `TARGET_NOT_ACTIVATABLE`. Revalidation never consults a newer policy version. | Recorded for the Architect (conformance with TD-A3-0). |
| C-3 | Target snapshot | `POLICY_ACTIVATE` payload gains `target_content_checksum` (SHA-256 hex). When the client omits it, `create` fills it from the target row before the payload checksum is taken; inside the create transaction it must equal the target's current checksum (`policy_version_changed`). Closed key set `{policy_version_id, target_content_checksum}`. | — |
| C-4 | Draft authoring routes (handoff §5.6 "editable … by platform_owner or finance_admin") | `GET /platform/commercial/policy-versions`, `POST …/policy-versions` (create a DRAFT from a version), `PATCH …/policy-versions/:id` (edit a DRAFT). Route gate `platform:approval:read` (no governance scope exists in the A1 catalog, TD-A3-5 precedent); below it the service requires the live `platform_owner` or `finance_admin` role. One DRAFT at a time. A DRAFT targeted by an open `POLICY_ACTIVATE` (DRAFT / PENDING_APPROVAL / APPROVED-not-applied) is locked (409). Draft edits are recorded in `CommercialAuditEvent` (format-checked type) because the policy audit CHECK is closed — no migration. | — |
| C-5 | Audit export (handoff §5.7 "the export is itself an audit event"; brief "if the A2 route supports it") | The A2 route is a GET read and cannot record anything, so B5 adds `POST /platform/commercial/audit-events/export` under the same scope. It builds the CSV server-side from the filtered rows (bounded), then appends exactly one `COMMERCIAL_AUDIT_EXPORTED` event; it writes nothing else. The A2 list gains two additive filters, `change_request_id` and `product_key`. | — |
| C-6 | Roster + chain state for Platform admins (handoff §5.8, §3.2) | `GET /platform/commercial/operators`, gate `platform:approval:read`: the live platform roster (name, email, role keys, attestation, last-owner flag, pending role requests) and the fulfillability of the five handoff chains computed with the A3 `checkChainSatisfiable` (maker + distinct step holders). super_admin holds no commercial scope and is refused (INV-1); its Platform admins page keeps the PLATFORM-UX-1 view. | — |
| C-7 | Role changes from the console | Only `POST /platform/commercial/change-requests` with `ROLE_GRANT` / `ROLE_REVOKE` (A9 C-3), one request per role toggled, submitted at once. No other grant path is added; the invite stays arrivals-only (TD-A9-4). | — |
| C-8 | Rail | B1 owns the Commercial rail group; B5 adds routes `/commercial/policy`, `/commercial/audit` and widens the `/admins` route gate only (App.tsx). The rail items B1 must link are reported. | — |

## 4. Correction-1 triggers (§2.4)

None has arisen. C-1 changes no state machine and replaces no function; it uses the A2 policy trigger's permitted transitions and the A3 apply-time check. No new scope, role or nx edge; no migration; no new regulatory or commercial decision; no governing-contract amendment. If a reviewer requires the request row itself to reach APPLIED, that needs the guard delta in TD-B5-1, to be coordinated with A6 — reported, not executed.

## 5. Pinned design handoff (PBD §2.5; PLATFORM-UX-1 Amendment A1-5)

Source: OneDrive `Aramo/design/Platform-Admin-prototype/ccp/CCP-UI-v1_0/`. `shasum -a 256 -c MANIFEST.sha256` on 2026-10-25: **5 / 5 OK**.

| SHA-256 | File |
|---|---|
| `276ac8192e9f39adaf3230904b918852b59200e6e35c0b1933d42ad90ef198a2` | `Commercial Control Plane v1.0.dc.html` |
| `313fe1e1b67115688862921d4b273b1be07be6445b7d9dfa021d517a62e7b3df` | `ccp-data.js` (prototype only, never shipped) |
| `8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe` | `support.js` |
| `385e629f5b6453892cff55a955dd1ab671d655396ccb39df6b3a477e78b5049b` | `handoff/Commercial Control Plane - Claude Code handoff v1.0.md` |
| `721f7122196dd21e13bf51e6033c4c96c0152f183f5352ffcaf4d4a7d0fec01c` | `handoff/Commercial Control Plane - design amendments log v1.0.md` (no amendments) |

Rows covered (handoff §11): "Policy: versions, draft edit, diff, activation / rollback requests" (§5.6; B5-P), "Audit explorer, exception flag, CSV export (audited)" (§5.7), "Platform admins: role chips, chain fulfillability, last-owner guard, role change requests" (§5.8, §3.2, §3.3). The byte-identical release is copied to `doc/design-reference/ccp/CCP-UI-v1_0/` for the parity harness (same path and bytes as B1's copy).
