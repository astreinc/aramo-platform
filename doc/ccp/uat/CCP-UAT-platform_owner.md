# CCP UAT — platform_owner

**Purpose.** Confirm by hand what a Platform owner sees and can do in the Commercial console: the Owner step of the Finance → Owner chains (catalog publish and retire, policy activation, escalated credit or discount), role changes (which need a second, distinct platform owner), and that the Owner never applies a request someone else made (TD-B2-3, TD-A6-3).

Automated twin: `apps/platform-web/e2e/journeys/ccp-d4-role-journeys.spec.ts` › `platform_owner`.

## Preconditions

- **Never run in production.** Use a non-production environment (local stack or staging) with a seeded, active commercial policy (v1).
- Test accounts, each holding **exactly one** role and D9-attested (Platform admins › commercial roles shows no "No one-account-per-human attestation" note for them):
  - **OWNER-A** platform_owner (the tester), **OWNER-B** a second platform_owner (role-change step), **FIN-A** finance_admin, **CAT-A** catalog_manager, **OPS-A** commercial_ops.
  - For check N3 only: **DUAL-X**, one separate account holding finance_admin **and** platform_owner.
- A plan with a DRAFT version in the catalog (for example Sign Team v3).
- A self-service test tenant (Tenant › Commercial shows "Managed in Stripe.").

## Steps

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Sign in as OWNER-A. Open the Dashboard. | Dashboard opens. No money amounts appear on it (TD-B1-2). |
| 2 | Look at the rail. | A **Commercial** group with Approvals, Subscriptions, Catalog, Contracts, Policy, Audit, Support extensions. |
| 3 | Open each of the seven Commercial items. | Each screen opens (headings: Approvals, Subscriptions, Catalog, Contracts, Commercial policy, Commercial audit, Support extensions). No access-denied card. |
| 4 | As CAT-A, open Catalog › the DRAFT version › **Request publish…**, fill Reason and Evidence, **Submit for approval**. Note the request id from the toast "… submitted · Finance → Owner". | The version shows "Publish request … is pending approval." |
| 5 | As OWNER-A, open Approvals › **All pending** › that request. | Drawer verdict: "You can’t approve: Out of order". Approve and Reject… are disabled; footnote "Out of order." (Finance signs first.) |
| 6 | As FIN-A, sign the Finance step (Approve → confirm Approve). | Toast "Finance step signed. Waiting on the next approver." |
| 7 | As OWNER-A, open the request again (it is now under **Waiting on me**). | Verdict "You can sign the Owner step". Approve → the confirm dialog reads "You sign the Owner step as Platform owner." and "This is the last step: the request becomes Approved." Confirm. Toast "… approved." |
| 8 | As OWNER-A, open Catalog › that version. | "Publish request … is approved." **No Apply button** (only CAT-A, the requester, may apply). |
| 9 | As CAT-A, click **Apply** on the version. | Toast "… applied." The version chip shows Published. |
| 10 | As OWNER-A, open Commercial audit; type the request id into **Change request**. | Rows: Change request drafted, Change request submitted, Approval step signed (twice: Finance admin, Platform owner), Change request approved, Change applied — each with the actor's name and roles. |
| 11 | As OPS-A, raise a conversion on the self-service tenant (Tenant › Commercial › **Request conversion to MANUAL…** › Reason, Evidence › **Submit for approval**). As OWNER-A open it in Approvals. | Verdict "You can’t approve: Missing the scope for this step" — conversion is Finance-only (TD-A3-2), and an Owner cannot fill a Finance step (TD-A3-6). |
| 12 | As OWNER-A open Tenant › Commercial on the self-service tenant. | Note "View only. You can view this tenant’s commercial state. Requests need the Commercial ops role; support extensions need Support admin." **Request conversion to MANUAL…** and **Request support extension…** are disabled. |
| 13 | As OWNER-A open Contracts and select a contract. | The contract opens. |
| 14 | Role change: Platform admins › a person's row › **Request role change…**, toggle one role, add Reason and Evidence, **Submit for approval**. Then open the request in Approvals as OWNER-A. | Verdict "You can’t approve: You requested this" (self-approval refused). |
| 15 | As OWNER-B, sign the role change. | The drawer shows "The role change was applied." (the role change applies inside the final approval). |

## Negative checks

| # | Check | Expected result |
|---|-------|-----------------|
| N1 | Self-approval: step 14. | Refused with "You requested this". |
| N2 | Not-requester apply: step 8. | No Apply button for OWNER-A on a request CAT-A made. |
| N3 | One person, several roles: DUAL-X signs the Finance step of a new catalog request, then opens it again. | "You can’t approve: You already approved a step" on the Owner step. One person fills at most one step. |
| N4 | Tenant isolation spot check: open Support extensions for tenant A, then for tenant B. | A request open on tenant A is not listed under tenant B. |

**Sign-off:** tester, date, environment, build SHA.
