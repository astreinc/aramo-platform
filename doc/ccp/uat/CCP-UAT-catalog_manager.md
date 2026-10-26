# CCP UAT — catalog_manager

**Purpose.** Confirm by hand that a Catalog manager drafts catalog versions and requests their publish or retire, that the request goes Finance → Owner, that only the Catalog manager who made it applies it, and that the role has no Contracts, Subscriptions, Support extensions or Audit (TD-B4-3).

Automated twin: `apps/platform-web/e2e/journeys/ccp-d4-role-journeys.spec.ts` › `catalog_manager`.

## Preconditions

- **Never run in production.** Use a non-production environment (local stack or staging) with an active commercial policy (v1).
- Test accounts, each holding **exactly one** role and D9-attested: **CAT-A** catalog_manager (the tester), **CAT-B** a second catalog_manager (not-requester check), **FIN-A** finance_admin, **OWNER-A** platform_owner.
- A plan with a PUBLISHED version and no open request on it.

## Steps

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Sign in as CAT-A. Open the Dashboard. | Dashboard opens with no money amounts on it. |
| 2 | Look at the rail. | Commercial group: **Approvals, Catalog, Policy** only. No Contracts, Subscriptions, Audit or Support extensions. |
| 3 | Open `/commercial/contracts` directly. | In-shell card "This account can't open Commercial contracts", "Your roles don’t include access to this page.", missing permission `platform:subscription:read`. The URL does not change. |
| 4 | Repeat for `/commercial/subscriptions`, `/commercial/support-extensions`, `/commercial/audit`. | The same card, naming `platform:subscription:read` (or `platform:commercial:audit:read` for Audit). |
| 5 | Catalog › the plan › its published version › **Create new draft from v{n}**, edit a price field and leave it. | A new DRAFT version; toast "Draft v… created. Published v… is unchanged." The edit is saved on blur. |
| 6 | On the draft, **Request publish…**. | Dialog "Request publish · Sign {plan} v{n}" with the draft compared to the published version and the chain Finance → Owner. **Submit for approval** stays disabled until Reason and Evidence are filled. |
| 7 | Fill both, **Submit for approval**. | Toast "… submitted · Finance → Owner". The version shows "Publish request … is pending approval." **No Apply.** |
| 8 | Open the request (the link in that line). | "You can’t approve: You requested this". Approve and Reject… disabled. |
| 9 | As FIN-A sign the Finance step; as OWNER-A sign the Owner step. | After the Owner step: "… approved." |
| 10 | As CAT-B open the version. | "Publish request … is approved." **No Apply** (CAT-B did not make it). |
| 11 | As CAT-A open the version, click **Apply**. | Toast "… applied." The version chip shows Published; existing tenants stay on their pinned version. |
| 12 | Open the request drawer again. | Timeline: Submitted for approval, Finance step signed, Owner step signed, Approved, Applied. |
| 13 | Retire: on a published version, **Request retire…**. | Dialog "Request retire · Sign {plan} v{n}". **Submit for approval** stays disabled until Reason, Evidence and the typed "{plan} v{n}" confirmation are filled. Press Escape to cancel (nothing is sent). |

## Negative checks

| # | Check | Expected result |
|---|-------|-----------------|
| N1 | Self-approval: step 8. | Refused, "You requested this". |
| N2 | Not-requester apply: step 10. | No Apply for CAT-B. |
| N3 | No Contracts: steps 2–3. | Not in the rail; deep link denied naming `platform:subscription:read`. |
| N4 | Apply before approval: step 7. | No Apply while the request is pending. |

**Sign-off:** tester, date, environment, build SHA.
