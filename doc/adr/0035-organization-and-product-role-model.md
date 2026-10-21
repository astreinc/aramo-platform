# ADR-0035 — Organization and Product Role Model

**Status:** ACCEPTED (2026-10-20). Lead Architect disposition: **APPROVED WITH IMPLEMENTATION SAFEGUARDS**, R1–R5 approved and D-1 to D-4 ruled (see §6). PO rulings are captured from the 2026-10-20 session.
**Date:** 2026-10-20
**Deciders:** PO (product rulings), Lead/Architect (technical ruling and lock)
**Baseline:** `origin/main` `5a96f65b`
**Supersedes, in part (amendments required):**
- IC-3 PR-7: `org_admin` as the only product-neutral role.
- IC-3 PR-8: no ATS role holds `sign:envelope:send`; Sign roles form a separate partition.
- D-ORG §3.F: `tenant_owner` and `tenant_admin` sit in the ATS product partition.
- PX-V1 PX-3: the four Sign roles.
- Sign Signup Federated Owner v1.2: the signup owner receives `sign_owner`.

**Related:**
- ADR-0034 (shared document template library): its D11 and O-6 depend on this ADR.
- IC-2 PR-6: consumer-isolated sessions, which this ADR keeps unchanged.

## 1. Context

Today the roles mix two meanings:
- **`tenant_owner` and `tenant_admin` are ATS product roles.**
  - They are in `ATS_PRODUCT_ROLE_KEYS` (`libs/identity/src/lib/dto/role.dto.ts:131-145`).
  - They can be assigned only in a tenant that has the `ats` capability, and their permission sets are ATS supersets.
- **`org_admin` (IC-3 PR-7) is the only organization role.**
  - It holds only `ORG_ADMIN_SCOPE_KEYS`: profile, domains, sites, users, settings, directory, audit and session.
  - It is the owner role of a Sign-only tenant, but it has **no Sign rights**.
- **Sign has its own owner and admin:** `sign_owner` (admin rights plus `S.BILLING_MANAGE`, the subscribing owner) and `sign_admin`, alongside `sign_sender` and `sign_viewer` (`libs/identity/src/lib/dto/esign-permissions.ts:33-58`).

**The result:**
- A Sign-only organization's top administrator can't administer Sign without a second grant.
- "tenant admin" really means "ATS admin".
- Organization administration is split across three roles.

## 2. Decision (PO rulings 2026-10-20)

### R1. Two organization roles: Owner and Admin of the whole tenant
- **`tenant_owner`** and **`tenant_admin`** are **organization-level** roles: the owner and the superuser of the whole tenant.
  - "Organization level" means across all of *this tenant's* products. It does not mean Aramo platform level: the SaaS operator role `super_admin` is unchanged and separate.
- **Rights:** both hold the organization permissions, plus the **admin permissions of every product the tenant holds** (ATS, Sign, and future products).
  - The product permissions come from the tenant's capabilities. A Sign-only tenant's Owner and Admin get organization and Sign rights; a tenant with both products gets everything.
  - When a product is added to or removed from a tenant, the Owner and Admin gain or lose its rights automatically, with no change to role assignments.
- **Sending:** both **can send Sign envelopes**. They hold `sign:envelope:send`.
- **Owner only:** `tenant_owner` = `tenant_admin` plus the owner-only acts:
  - billing and subscriptions, including Sign billing, which is `S.BILLING_MANAGE` today;
  - ownership transfer;
  - the sign-in provider pin (it already uses `PIN_OWNER_ROLE_KEYS`);
  - closing the organization.
- **One owner role per tenant (PO 2026-10-20):** `tenant_owner` is the **only** owner role, and there is no product-level owner (no `sign_owner`, no `ats_owner`).
  - **More than one owner:** more than one person may hold it.
  - **Always at least one:** the last holder can't be removed, keeping the existing last-owner protection.

### R2. Product admin roles for delegation
- **`ats_admin`** administers **ATS only**.
- **`sign_admin`** administers **Sign only**. It already exists and is kept.
- **Who they're for:** people who should run one product and not the other. These roles do not grant organization administration (users, domains, sites, settings).
- **Product-specific roles are unchanged:** recruiter, account manager and the other ATS roles, plus `sign_sender` and `sign_viewer`.

### R3. Renames and removals
| Today | After | How |
|---|---|---|
| `tenant_admin` (ATS superset) | **`ats_admin`** | Rename: same role row, new key |
| `org_admin` | **`tenant_admin`** | Rename: same role row, new key, with its permission set widened per R1 |
| `tenant_owner` | `tenant_owner` | Key unchanged; permission set widened per R1 |
| `sign_admin` | `sign_admin` | Unchanged |
| `sign_owner` | **removed** | Its rights move to `tenant_owner` (billing) and `tenant_admin` (Sign admin). Holders are migrated (§3) |

### R4. Defaults for new tenants
- **Personal Sign users** get **`tenant_owner` and `tenant_admin`** by default.
- **Sign self-service signup** gives the signing-up owner `tenant_owner` and `tenant_admin`, not `sign_owner` (amends Sign Signup Federated Owner v1.2).
- **ATS tenant provisioning** gives the first owner `tenant_owner`, as today.

### R5. Session isolation stays
- **Unchanged:** IC-2 PR-6 already limits each session to the permissions of the app being used.
- **What it means for these roles:** an organization-level Owner signed into ATS carries ATS and organization permissions only, and in Sign, Sign and organization permissions only. The role covers every product; a single session still covers one app.

## 3. Migration

1. **Rename order (one transaction):** `tenant_admin` → `ats_admin` first, then `org_admin` → `tenant_admin`. Role keys are unique, so the order matters. Role row IDs and every membership assignment are kept.
2. **Existing `tenant_admin` holders, who become `ats_admin` (open item D-1):** today they also hold organization rights (users, sites, settings). A pure rename would take those away.
   - **Recommendation:** grant them `ats_admin` **and** the new `tenant_admin`, so nobody loses access. Owners then remove what isn't wanted.
3. **`sign_owner` holders:**
   - **Default:** grant `tenant_owner`, plus `tenant_admin` if they don't already hold it, then delete the role.
   - **Last-owner rule:** the last-owner protection in Sign members (`apps/sign-service/src/app/sender/sender-members.service.ts:104-119`) moves to `tenant_owner`.
   - **Subscription owner:** the subscribing owner (`SUBSCRIBING_OWNER_ROLE`, `esign-owner-activation.service.ts:14`) becomes `tenant_owner`.
4. **Astre:** the PO already holds `tenant_owner` and `tenant_admin`, which cover `sign_admin` and `ats_admin` under R1. The PO's `sign_owner` and `sign_admin` grants become redundant and are removed by the migration.
5. **Code touch points** (files referencing each key at `5a96f65b`, counting `.ts`/`.tsx`/`.sql`):

   | Key | Files |
   |---|---|
   | `tenant_admin` | 26 |
   | `tenant_owner` | 35 |
   | `org_admin` | 24 |
   | `sign_owner` | 16 |
   | `sign_admin` | 12 |

   Named sets also change: `ATS_PRODUCT_ROLE_KEYS`, `ESIGN_PRODUCT_ROLE_KEYS`, `ORG_ADMIN_SCOPE_KEYS`, `TENANT_ACTIVATING_OWNER_ROLE_KEYS`, `PIN_OWNER_ROLE_KEYS`, `ESIGN_ROLE_KEYS`, the role pickers in `libs/org-admin-web` and `apps/sign-web`, and the seeded role-permission count pinned in `libs/identity/src/tests/identity.integration.spec.ts:482`.
6. **Sessions:** effective permissions are resolved on the server at each request (HF-AUTH-1), so renamed roles take effect without forcing users to sign in again. The migration must still be checked for any cached role keys.

## 4. Consequences

**Positive**
- One clear organization owner and admin for every tenant, whatever products it has.
- A Sign-only tenant's admin can run Sign without an extra grant.
- Delegation is still possible per product (`ats_admin`, `sign_admin`).
- The duplicated organization-admin roles are removed.

**Negative / costs**
- **Meaning change for `tenant_admin`:** after the migration the key exists but means something different. Every reference must be reviewed, and none can be find-and-replaced blindly.
- **Locked directives:** it needs amendments to IC-3 PR-7 and PR-8, D-ORG §3.F, PX-V1 PX-3 and Sign Signup v1.2.
- **Broader sending rights:** sending now extends to organization roles. The IC-3 PR-8 rule "send authority derives from the `sign` capability plus an org role" still holds, because Owner and Admin are org roles and still need the tenant's `sign` capability.

## 5. Open items (all ruled; see §6)

- **D-1:** do existing `tenant_admin` holders keep their organization rights after becoming `ats_admin`? The recommendation is yes, by also granting the new `tenant_admin` (§3.2).
- **D-2:** the exact `ats_admin` permission set: today's ATS superset minus the organization permissions in `ORG_ADMIN_SCOPE_KEYS`.
- **D-3:** whether `sign_admin` keeps Sign billing management. Today only `sign_owner` has it; the proposal is that billing becomes Owner only.
- **D-4:** production recon before the migration: count the holders of each role per tenant on the box (read-only), so the migration can be checked against real data.

## 6. Ratification (Lead Architect, 2026-10-20)

**Disposition:** APPROVED WITH IMPLEMENTATION SAFEGUARDS. R1–R5 are approved. The governing principle is organization-wide administration over subscribed products, without removing product-level authorization boundaries.

**Governing role model**

| Role | Authority |
|---|---|
| `tenant_owner` | Organization owner: administration of entitled products, billing, ownership transfer and organization closure |
| `tenant_admin` | Organization administrator: administration of entitled products, excluding owner-only functions |
| `ats_admin` | ATS-specific administration |
| `sign_admin` | Sign-specific administration |
| `sign_sender` | Sign sending |
| `sign_viewer` | Sign viewing |

`org_admin` and `sign_owner` are retired through a governed role migration. The platform `super_admin` stays separate.

**Rulings on the open items**
- **D-1:** existing ATS `tenant_admin` holders keep their current effective rights. Where needed, they also get the new organization `tenant_admin` role. **Every resulting privilege expansion is recorded explicitly.**
- **D-2:** `ats_admin` keeps today's ATS administrative permissions, excluding the organization-wide permission set.
- **D-3:** Sign billing management is **`tenant_owner` only**. Neither `tenant_admin` nor `sign_admin` inherits billing management.
- **D-4:** a read-only reconciliation of production roles is mandatory before the migration. It captures assignments and effective permissions both before and after.

**Additional safeguards**
1. **`sign_owner` migration:** it must not silently make anyone an organization-wide owner. It keeps their existing authorized access, verifies their existing authority and intended ownership, and identifies any privilege expansion for explicit reconciliation before `tenant_owner` is assigned. This supersedes the §3.3 default.
2. **Last owner:** the last-owner invariant must hold under concurrent role changes, enforced in the data layer and not only in the UI.
3. **Preserved as-is:** consumer-isolated sessions (IC-2 PR-6) and capability-scoped permissions.
4. **LOCKED conflicts:** the five conflicting LOCKED instruments listed in the header are handled through explicit amendments. Historical LOCKED documents are not modified.
5. **Gate-5 review:** production role migrations, deployment and authorization expansion remain subject to an implementation Gate-5 review.
