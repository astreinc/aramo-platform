# CCP UAT — finance_admin

**Purpose.** Confirm by hand that a Finance admin signs the Finance step of every chain — alone for the Finance-only chains (subscription, entitlement, conversion, escalated support extension) and first for the Finance → Owner chains (catalog publish and retire, policy activation, escalated credit or discount) — and that Finance never signs twice, never signs its own request, and never applies a request someone else made (TD-A3-2, TD-A3-6, TD-B2-3).

Automated twin: `apps/platform-web/e2e/journeys/ccp-d4-role-journeys.spec.ts` › `finance_admin`.

## Preconditions

- **Never run in production.** Use a non-production environment (local stack or staging) with an active commercial policy (v1) and a DRAFT policy version (v2).
- Test accounts, each holding **exactly one** role and D9-attested:
  - **FIN-A** finance_admin (the tester), **FIN-B** a second finance_admin (signs FIN-A's own policy request), **OWNER-A** platform_owner, **CAT-A** catalog_manager, **OPS-A** commercial_ops, **SUP-A** support_admin.
- A self-service test tenant that is PAST_DUE (for the support extension) and a self-service tenant with no open request (for the conversion).

## Steps

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Sign in as FIN-A. Open the Dashboard. | Dashboard opens with no money amounts on it (TD-B1-2). |
| 2 | Look at the rail, then open each Commercial item. | Approvals, Subscriptions, Catalog, Contracts, Policy, Audit, Support extensions — all open, no access-denied card. |
| 3 | As CAT-A, request publish of a DRAFT catalog version (Reason, Evidence, **Submit for approval**). | Toast "… submitted · Finance → Owner". |
| 4 | As FIN-A, open Approvals. | The request is under **Waiting on me**. |
| 5 | Open it. | Verdict "You can sign the Finance step". |
| 6 | **Approve** → the confirm dialog → **Approve**. | Dialog text "You sign the Finance step as Finance admin." Toast "Finance step signed. Waiting on the next approver." |
| 7 | Open the same request again. | "You can’t approve: You already approved a step". Approve and Reject… disabled. |
| 8 | As SUP-A, open Support extensions › the PAST_DUE tenant › **Request support extension…**, set **Extension (days)** to 20, Reason, **Submit for approval**. | Notice "Escalated to Finance — nothing was applied. More than 14 days in one extension." |
| 9 | As FIN-A, open that request and approve. | The confirm dialog says "This is the last step: the request becomes Approved." Toast "… approved." (Finance-only chain.) |
| 10 | As FIN-A, open Support extensions for that tenant. | "Open request … · … approved." line, **no Apply button** (only SUP-A may apply). |
| 11 | As SUP-A, click **Apply**. | Toast "Change applied." |
| 12 | As OPS-A, Tenant › Commercial › **Request conversion to MANUAL…**, Reason, Evidence, **Submit for approval**. As FIN-A approve it. | Toast "… approved." On Tenant › Commercial, FIN-A sees the open request and **no Apply**. |
| 13 | As OPS-A click **Apply** on that tenant. | Toast "Sent to Stripe — awaiting confirmation." (or "Conversion applied." once Stripe confirms). |
| 14 | As FIN-A open Commercial policy › v2 (draft) › **Request activation…**, Reason, Evidence, **Submit for approval**. Then open that request in Approvals. | "You can’t approve: You requested this" (self-approval refused). |
| 15 | As FIN-B sign the Finance step; as OWNER-A sign the Owner step. As FIN-A open Commercial policy. | **Apply activation** is offered to FIN-A (the requester). Apply it; v2 becomes the active version. |
| 16 | Open Contracts, then Commercial audit; filter by one of the request ids above. | Contracts open. Audit lists each step: Change request submitted, Approval step signed, Change applied (or Support extension applied), with actor names and roles. |

## Negative checks

| # | Check | Expected result |
|---|-------|-----------------|
| N1 | Self-approval: step 14. | Refused, "You requested this". |
| N2 | Not-requester apply: steps 10 and 12. | No Apply for FIN-A. |
| N3 | One person, several roles: an account holding finance_admin + platform_owner signs the Finance step of a catalog request, then reopens it. | "You already approved a step" on the Owner step. |
| N4 | Reject: open a pending request FIN-A may sign, **Reject…**. | **Reject request** stays disabled until "Reason (required)" is filled; after it the request shows Rejected. |
| N5 | Tenant isolation spot check: an open request on tenant A. Open Support extensions for tenant B. | Tenant A's request is not listed for tenant B. |

**Sign-off:** tester, date, environment, build SHA.
