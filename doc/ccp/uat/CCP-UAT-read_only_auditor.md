# CCP UAT — read_only_auditor

**Purpose.** Confirm by hand that a Read-only auditor sees every Commercial screen and the full audit trail, can export the audit, and can make, sign or apply nothing.

Automated twin: `apps/platform-web/e2e/journeys/ccp-d4-role-journeys.spec.ts` › `read_only_auditor`.

## Preconditions

- **Never run in production.** Use a non-production environment (local stack or staging) with an active commercial policy (v1).
- Test accounts, each holding **exactly one** role and D9-attested: **AUD-A** read_only_auditor (the tester), plus the accounts that produce the trail: **CAT-A** catalog_manager, **FIN-A** finance_admin, **OWNER-A** platform_owner.
- One catalog publish taken through the whole chain and applied (CAT-A request → FIN-A → OWNER-A → CAT-A Apply), and one more publish request left pending.

## Steps

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Sign in as AUD-A. Open the Dashboard. | Dashboard opens with no money amounts on it. |
| 2 | Look at the rail, then open each Commercial item. | Approvals, Subscriptions, Catalog, Contracts, Policy, Audit, Support extensions — all open. |
| 3 | Approvals › **All pending** › the pending request. | "You can’t approve: Missing the scope for this step". Approve and Reject… disabled. |
| 4 | Catalog. | Note "View only. You can view the catalog. Drafting, publishing and retiring versions needs the Catalog manager role." |
| 5 | Support extensions › any tenant. | Note "View only. You can view this tenant’s commercial state. Requests need the Commercial ops role; support extensions need Support admin." **Request support extension…** disabled. |
| 6 | Tenants › a tenant › **Commercial** tab. | The same "View only." note; every request action disabled. |
| 7 | Contracts › a contract. | **Record amendment…** and **End contract…** are disabled with the tooltip "Needs the Commercial ops role." |
| 8 | Open a version with an APPROVED (not yet applied) request, if one exists. | "Publish request … is approved." **No Apply.** |
| 9 | Commercial audit; type the applied request's id into **Change request**. | Change request drafted, Change request submitted, Approval step signed (two rows: Finance admin, Platform owner), Change request approved, Change applied — with the names CAT-A, FIN-A, OWNER-A and their roles. |
| 10 | Tick **Exceptions only**. | Only events flagged EXCEPTION remain (for example Support extension applied as an exception). Untick. |
| 11 | **Export CSV**. | Toast "Exported N events. The export is itself recorded." Reload: an "Audit exported" row by AUD-A. |

## Negative checks

| # | Check | Expected result |
|---|-------|-----------------|
| N1 | No signing: step 3. | Refused, "Missing the scope for this step". |
| N2 | No apply: step 8. | No Apply. |
| N3 | No requests anywhere: steps 4–7. | Every request action absent or disabled with its reason. |
| N4 | Tenant isolation spot check: filter Audit by tenant A. | Only events of tenant A are listed. |

**Sign-off:** tester, date, environment, build SHA.
