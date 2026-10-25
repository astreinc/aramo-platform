# CCP UAT — super_admin

**Purpose.** Confirm by hand that super_admin holds **no** commercial authority: no Commercial group in the rail, every Commercial deep link lands on the in-shell access-denied card, and tenant operations are unchanged.

Automated twin: `apps/platform-web/e2e/journeys/ccp-d4-role-journeys.spec.ts` › `super_admin`.

## Preconditions

- **Never run in production.** Use a non-production environment (local stack or staging).
- One test account **SA-A** holding **only** super_admin (no commercial role).
- At least one tenant.

## Steps

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Sign in as SA-A. Open the Dashboard. | Dashboard opens with no money amounts on it. |
| 2 | Look at the rail. | No **Commercial** group: no Approvals, Subscriptions, Catalog, Contracts, Policy, Audit or Support extensions. Tenants is present. |
| 3 | Open `/commercial/approvals` directly. | In-shell card: heading "This account can't open Commercial approvals"; "Super admin holds no commercial authority. Commercial screens are open only to people with a commercial role."; the six role chips Platform owner, Finance admin, Commercial ops, Catalog manager, Support admin, Read-only auditor; the missing permission `platform:approval:read`; buttons **Sign in with a different account**, **Sign out**, **Back to dashboard**; footnote "Tenant operations are unchanged for this account. Commercial authority is held only by the commercial roles above." The URL does not change. |
| 4 | Repeat for `/commercial/subscriptions`, `/commercial/catalog`, `/commercial/contracts`, `/commercial/policy`, `/commercial/audit`, `/commercial/support-extensions`. | The same card each time ("Commercial subscriptions", "… catalog", "… contracts", "… policy", "… audit", "… support extensions"), naming that page's permission. |
| 5 | **Back to dashboard**. | The Dashboard opens. |
| 6 | Tenants › open a tenant. | The tenant opens. There is **no Commercial tab**. |
| 7 | Platform admins. | The invite view (not the commercial roles roster). |

## Negative checks

| # | Check | Expected result |
|---|-------|-----------------|
| N1 | No commercial authority: steps 2–4. | Never a Commercial screen; never a redirect. |

**Sign-off:** tester, date, environment, build SHA.
