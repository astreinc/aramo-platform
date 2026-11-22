# Aramo Sign: feature parity record (web / mobile / server)

Governed by `Aramo-Sign-Client-Rule-Consolidation-Directive-v1_0-LOCKED` (sha256 480ecdbb…) §6 C4.

- **Every Sign PR updates this table (directive G-6).** A PR that adds, removes or changes a
  user-facing Sign feature on any client changes its row here in the same PR, or names the
  parity gap it leaves and why.
- **This record builds nothing.** Building a feature that exists on one client only on the
  other client is out of scope of the consolidation directive (§6 C4-3); each needs its own
  PO decision.
- Rules that must run on the device live once in `libs/sign-client` (`@aramo/sign-client`);
  what a user may do with an envelope or an inbox item is the server's `actions` (C1).
- Basis: the client rule duplication audit at `origin/main` `1e4ff1ed` (2026-11-21) §2, plus
  what C3 found while migrating the rules.

Key: **Yes** = built; **No** = not built on that client; **—** = not applicable. "Server" names
the server surface (sign-service) the feature uses.

## 1. Sender (envelopes)

| Feature | Web (`apps/sign-web`) | Mobile (`mobile/sign`) | Server | Notes |
|---|---|---|---|---|
| Create an envelope (upload, recipients, fields, send) | Yes | Yes | `/v1/sign/sender/envelopes*` | Limits, email, phone, access code, file checks from `@aramo/sign-client` on both. |
| Envelope list with folders (All / Drafts / Waiting / Completed …) | Yes | Yes | `GET /v1/sign/sender/envelopes` | Folder grouping is per screen; status sets from the library. |
| Row and detail actions (edit, send, delete draft, void, remind, sign) | Yes | Yes | `actions` on every row and detail (C1) | Both clients render `actions` only (C3). |
| Void a sent envelope | Yes | Yes | `POST …/void` | A DRAFT is deleted, never voided (C3 DV-void-draft, PO ratification pending). |
| Remind one signer / everyone who may sign now | Yes | Yes | `POST …/remind` | Cooldown per recipient: `reminder_available_at`. |
| Delete a draft | Yes | Yes | `DELETE …/envelopes/{id}` | |
| Sign from the sender list / detail ("Waiting for you", Sign now) | Yes | Yes | `actions.sign`, `my_inbox_item_id`, self-sign session | |
| Download executed documents and certificate | Yes | Yes (share, certificate) | `GET …/executed` | `actions.download` / `actions.certificate`. |
| Sender Deleted folder: delete and restore | Yes | No | `POST …/delete`, `…/restore` | Web only (audit §2). |
| Retention, purge, cancel purge, targeted purge | Yes | No | `POST …/purge`, `…/purge/dequeue`, retention policy | Web only. |
| Evidence card (event-chain hash) | Yes | No | `GET …/evidence` | Web only. |
| PAYMENT fields and Stripe Connect payments | Yes (shown locked in the editor; placed through the API) | No | Sign 1.14 payments | Neither editor authors a payment's amount today, so PAYMENT is not offered for placing on either client (C3 DV-payment-placement). |
| Branding, custom roles, reports, activity, documents library, dashboard summary | Yes | No | branding / roles / reports routes | Web only. |
| Document reorder | Yes | No | `PATCH …/documents` | Web only. |
| Template Studio authoring | Yes | No | Template Studio routes | Web only. |
| Use a template | Yes | Yes | `POST …/from-template` | One access rule: `templateAccess` (C3). |
| Template favorites | No | Yes | device-local | Mobile only. |
| Billing checkout, portal, seats and usage | Yes | No | `/v1/sign/billing/*` | Web only. Plan facts come from `/plans` and `/account` only (C3). |
| Store purchase and restore (App Store / Google Play) | No | Yes | store billing routes | Mobile only. |
| Legal notices (upcoming-change notices) | Yes | No | legal routes | Web only (audit §2). |
| Accept updated legal terms | Yes | Yes | legal acceptance routes | |
| Domain verification | Yes | No | domain routes | Web only. |
| In-person hosting | No | Yes | `POST …/hosted-sessions`, per-recipient `hostable` (C3) | Mobile only. |
| Word upload (server converts to PDF) | No | Yes | `word_conversion_enabled` | Mobile only; the shared file check supports it, the web never allows it (C3). |
| Scan to PDF and photo import | No | Yes | — (device) | Mobile only. |
| Field suggestions | No | Yes | — (device) | Mobile only. |
| Sign a document yourself (self-sign) | Yes | Yes | SELF envelopes, self-sign session | |
| Contacts | Yes | Yes | `/v1/sign/sender/contacts` | |

## 2. Recipient

| Feature | Web | Mobile | Server | Notes |
|---|---|---|---|---|
| Sign from an emailed link | Yes | Yes | `/v1/sign/signing/*` | Finish rule: `signerFieldUnits` (C3). SIGN_DATE stamped by the server (C0). |
| Inbox: sign, signed copy, delete, restore | Yes | Yes | `/v1/sign/inbox/*`, item `actions` (C1) | Both clients render item `actions` (C3). |
| Inbox-item report | No | Yes | `POST /v1/sign/inbox/{id}/report` | Mobile only. |
| Decline | Yes | Yes | `POST /v1/sign/signing/decline` | Reason non-empty on both (C3). |
| Delegate | Yes | Yes | `POST /v1/sign/signing/delegate` | Email at most 254, reason at most 500 on both (C3). |
| QES | Yes | No | regulated signing | Web only. |
| Payment checkout | Yes | No | Sign 1.14 | Web only. |
| Saved mark (default signature / initials) | Yes | Yes | `/v1/sign/me/signature`, `/initials` | The audit lists the saved mark on a recipient link as web only. |
| Copy-recipient view | Yes | No | copy delivery | Web only. |
| Signer branding | Yes | No | branding | Web only. |

## 3. Account and app

| Feature | Web | Mobile | Server | Notes |
|---|---|---|---|---|
| Sign in (Google, Microsoft, Apple) | Yes | Yes | auth-service | |
| Personal signup | Yes | Yes | platform signup | Signup pages show no plan numbers before the account exists (C3). |
| Profile and Sign preferences (date format, field size) | Yes | Yes | `/v1/sign/me/*` | Date formats and the E.164 phone rule from the library (C3). |
| Plan and allowance | Yes | Yes | `/v1/sign/billing/account` | Limit copy says "documents" on both (C3). |
| In-app notifications and push | No | Yes | push routes | Mobile only. |
| Signing stats | No | Yes | — | Mobile only. |
| Issue report | No | Yes | `POST /v1/sign/me/app-issues` | Mobile only. |
| Biometric unlock | No | Yes | — (device) | Mobile only. |
| Tasks | No | Yes | — | Mobile only. |
| Close account | Yes | Yes | `POST /v1/sign/account/close` | |
| Privacy requests (access, export, deletion) | Yes | Yes | `/v1/sign/me/privacy-requests` | |
