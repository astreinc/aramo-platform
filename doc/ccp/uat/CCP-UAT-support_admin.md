# CCP UAT — support_admin

**Purpose.** Confirm by hand that a Support admin extends a past-due subscription: within the policy bounds it applies at once as an audited exception (zero approvals); out of bounds it escalates to Finance (Finance-only, TD-A3-2) and only the Support admin who asked applies it (TD-B2-3). The role makes no other request, signs nothing, and has no Commercial audit.

Automated twin: `apps/platform-web/e2e/journeys/ccp-d4-role-journeys.spec.ts` › `support_admin`.

## Preconditions

- **Never run in production.** Use a non-production environment (local stack or staging) with an active commercial policy (v1: at most 14 days per extension, one per 90 days, 30 days cumulative per 365 days).
- Test accounts, each holding **exactly one** role and D9-attested: **SUP-A** support_admin (the tester), **SUP-B** a second support_admin (not-requester check), **FIN-A** finance_admin.
- Two PAST_DUE self-service test tenants, **T-A** and **T-B**, with no extension in the last 90 days.

## Steps

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Sign in as SUP-A. Open the Dashboard. | Dashboard opens with no money amounts on it. |
| 2 | Look at the rail. | Approvals, Subscriptions, Catalog, Contracts, Policy, Support extensions. **No Audit.** `/commercial/audit` shows the in-shell card naming `platform:commercial:audit:read`. |
| 3 | Support extensions › **Tenant** = T-A › **Request support extension…**. | Dialog "Request support extension · T-A", **Extension (days)** = 7, preview "Within bounds — applies now as an exception, with zero approvals". |
| 4 | Fill Reason, **Apply extension (exception)**. | Toast "Extension applied as an exception — zero approvals, flagged in audit." The card shows "Extension · exception" and Active extensions 1. |
| 5 | Tenant = T-B › **Request support extension…**, set days to 20. | Preview "Out of bounds — escalates to approval (Finance)"; the button reads **Submit for approval**. |
| 6 | Fill Reason, **Submit for approval**. | Notice "Escalated to Finance — nothing was applied. More than 14 days in one extension." An "Open request …" line, **no Apply**. **Request support extension…** is now disabled ("Another request on this product is open."). |
| 7 | Open the request (link). | "You can’t approve: You requested this". |
| 8 | As FIN-A approve it. | "This is the last step: the request becomes Approved." Toast "… approved." |
| 9 | As SUP-B open T-B. | The open request shows; **no Apply**. |
| 10 | As SUP-A open T-B, click **Apply**. | Toast "Change applied." The open-request line disappears; Active extensions 1. |
| 11 | Tenants › any self-service tenant › **Commercial** tab. | **Request support extension…** enabled; **Request conversion to MANUAL…**, plan change, cancel, grant and revoke disabled (they need Commercial ops). |

## Negative checks

| # | Check | Expected result |
|---|-------|-----------------|
| N1 | Self-approval: step 7. | Refused, "You requested this". |
| N2 | Not-requester apply: step 9. | No Apply for SUP-B. |
| N3 | Frequency bound: on T-A (extended in step 4), request 5 days. | Preview "Out of bounds — escalates to approval (Finance)" (a previous extension inside the 90-day window). Cancel. |
| N4 | Tenant isolation spot check: with T-B's request open (step 6), switch the Tenant picker to T-A. | T-B's open request is not listed under T-A. |
| N5 | One person, several roles: an account holding support_admin + finance_admin raises an escalated extension and opens it in Approvals. | "You requested this" — the same person never fills the Finance step of their own request. |

**Sign-off:** tester, date, environment, build SHA.
