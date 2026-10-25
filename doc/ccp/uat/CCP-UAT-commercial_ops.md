# CCP UAT — commercial_ops

**Purpose.** Confirm by hand that Commercial ops makes the commercial requests (conversion, plan change, cancel, grant, revoke, contract amendment) but signs none, applies only its own approved requests, and has no Commercial audit access.

Automated twin: `apps/platform-web/e2e/journeys/ccp-d4-role-journeys.spec.ts` › `commercial_ops`.

## Preconditions

- **Never run in production.** Use a non-production environment (local stack or staging) with an active commercial policy (v1).
- Test accounts, each holding **exactly one** role and D9-attested: **OPS-A** commercial_ops (the tester), **OPS-B** a second commercial_ops (not-requester check), **FIN-A** finance_admin, **CAT-A** catalog_manager.
- A self-service tenant with no open request (Tenant › Commercial shows "Managed in Stripe." and no "Open request" line).

## Steps

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Sign in as OPS-A. Open the Dashboard. | Dashboard opens with no money amounts on it. |
| 2 | Look at the rail. | Approvals, Subscriptions, Catalog, Contracts, Policy, Support extensions. **No Audit.** |
| 3 | Open `/commercial/audit` directly. | In-shell card "This account can't open Commercial audit", "Your roles don’t include access to this page.", missing permission `platform:commercial:audit:read`. The URL does not change. |
| 4 | Tenants › the self-service tenant › **Commercial** tab › **Request conversion to MANUAL…**. | Dialog "Request conversion to MANUAL · {tenant}" with the before → after rows and the chain "Below threshold · Finance". |
| 5 | Fill Reason and Evidence, **Submit for approval**. | Notice "Submitted for approval. Nothing applies until every step is signed and you apply it." with the request reference. An "Open request" line appears; **no Apply** yet. |
| 6 | Open the request in Approvals (link from the notice). | "You can’t approve: You requested this". Approve and Reject… disabled. **Withdraw** is offered (requester). |
| 7 | As FIN-A approve it. | Toast "… approved." |
| 8 | As OPS-B open the same tenant's Commercial tab. | The open request shows; **no Apply** (OPS-B did not make it). |
| 9 | As OPS-A open the tenant's Commercial tab. | **Apply** is offered. Click it: toast "Sent to Stripe — awaiting confirmation." The open-request line reads "Subscription conversion · sent to Stripe — awaiting confirmation. Other requests on this product wait until it closes." |
| 10 | Catalog. | Note "View only. You can view the catalog. Drafting, publishing and retiring versions needs the Catalog manager role." |
| 11 | As CAT-A request publish of a draft version; as OPS-A open it in Approvals. | "You can’t approve: Missing the scope for this step". |
| 12 | Support extensions › any tenant. | **Request support extension…** is disabled; its tooltip reads "Needs the Support admin role." |
| 13 | Contracts › select a contract. | **Record amendment…** is enabled. Opening it and submitting only creates a change request ("submitted for approval"). |

## Negative checks

| # | Check | Expected result |
|---|-------|-----------------|
| N1 | Self-approval: step 6. | Refused, "You requested this". |
| N2 | Not-requester apply: step 8. | No Apply for OPS-B. |
| N3 | No audit: step 3. | Access-denied card naming `platform:commercial:audit:read`. |
| N4 | One open request per tenant × product: with the conversion open, look at the other actions on the same card. | They are disabled; tooltip "Open request CR-…. Other requests on this product wait until it closes." |
| N5 | Tenant isolation spot check: open a second tenant's Commercial tab. | The first tenant's open request is not shown there. |

**Sign-off:** tester, date, environment, build SHA.
