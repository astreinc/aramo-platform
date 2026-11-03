# Contacts

A contact is a person, or a shared mailbox, at a company the tenant works with: a hiring manager, a
decision maker, a billing contact. This page describes how Contacts work today.

## Ownership

| Item | Value |
|---|---|
| Domain | ATS |
| Library | `libs/contact` (nx tag `scope:ats`) |
| Database | schema `contact`, table `Contact` (`libs/contact/prisma/schema.prisma`) |
| HTTP surface | `/v1/contacts` (`libs/contact/src/lib/contact.controller.ts`), documented in `openapi/ats.yaml` |
| Front end | `apps/ats-web/src/contacts/` |

Other libraries never import `@aramo/contact` to check a contact. Requisition, company, task and
activity each define a port in their own library; `apps/api` binds it to an adapter over
`ContactRepository`. This keeps the nx graph free of new library-to-library edges.

## Model

Every contact belongs to exactly one tenant and exactly one company. There is no contact without a
company and no contact with several companies.

| Field | Meaning |
|---|---|
| `id`, `tenant_id`, `site_id` | Identity and tenant/site axes. |
| `company_id` | The contact's company (`company.Company`, UUID reference, no foreign key). Required. |
| `company_department_id` | Optional department of that company. Must belong to the contact's company. |
| `first_name`, `last_name`, `title` | Name and job title. First and last name are required. |
| `email1`, `email2` | Email addresses (format-checked). |
| `phone_work`, `phone_cell`, `phone_other` | Phone numbers. |
| `address`, `address2`, `city`, `state`, `zip` | Free-text address. |
| `notes` | Free-text notes. |
| `is_hot` | Flag for contacts that need attention. |
| `is_primary` | The company's primary contact. At most one per company (partial unique index `Contact_one_primary_per_company_uidx`). Promoting a contact demotes the previous primary in the same transaction. |
| `left_company` | The person has left the company ("Former"). A Former contact is still live and can still be linked. |
| `reports_to_id` | Another live contact at the same company, never the contact itself. |
| `relationship_role` | The contact's function in the account: `decision_maker`, `hiring_manager`, `champion`, `influencer`, `gatekeeper` or `billing_contact`. A category, not a rating. Null means unclassified. |
| `preference` | Contactability: `contactable`, `limited` or `do_not_contact`. Null displays as contactable. Every call or email affordance honours it. This is a CRM preference on the contact row, not the talent consent ledger. |
| `contact_kind` | `PERSON` or `FUNCTIONAL_MAILBOX` (a shared inbox such as accounts payable). Null means not set. |
| `owner_id` | The account owner: the user responsible for the relationship. Must be an active user in the tenant. Defaults to the creating user. |
| `entered_by_id` | The user who created the contact. |
| `last_activity_at` | Time of the latest recorded interaction (see Activity history). |
| `deleted_at`, `deleted_by_id` | Set when the contact is deleted (see Lifecycle). |
| `import_batch_id` | The import batch that created the contact, if any. |
| `created_at`, `updated_at` | Timestamps. |

Responses also carry two read-time values that are not stored on the contact: `company_name` and
`relationship_types` (the active `CLIENT` / `VENDOR` / `PARTNER` relationships of the contact's
company).

The `relationship_role`, `preference` and `contact_kind` vocabularies are plain strings validated in
the application (`libs/contact/src/lib/dto/contact-vocab.ts`), not database enums.

## Visibility

Contacts follow the company visibility rule (D4b). An actor sees a contact when either:

- the actor holds `company:read:all` (`see_all_company`), or
- the contact's `company_id` is in the actor's visible client set (direct user-to-client assignments
  plus the clients owned by the actor's teams).

The rule applies to reads and writes alike. A contact outside the actor's visibility returns **404**
on every route: read, update, delete, restore and primary promotion. The response is the same as for a
contact that does not exist, so existence is never disclosed.

`owner_id` does not grant or limit visibility. "My contacts" (`scope=mine`) narrows the list to the
contacts the actor owns, inside the visible set; it never widens it.

## Lifecycle

Contacts are tenant-managed records. They are never hard-deleted by any user-facing flow.

- **Delete** (`DELETE /v1/contacts/{id}`, `contact:delete`) is a soft delete. It sets `deleted_at`
  and `deleted_by_id` and keeps the row. A primary contact loses `is_primary` in the same transaction.
- **Hidden.** A deleted contact is left out of every list, search, facet count and total, picker,
  enterprise search, export, report count, the task visibility set, My Desk and Talent 360. `GET
  /v1/contacts/{id}` returns 404 for it, and updates are refused with 404.
- **Existing references stay.** A requisition's hiring manager, a company's billing contact, a task
  and a saved-list entry keep pointing at a deleted contact. Screens that show the name read it with
  `GET /v1/contacts/{id}?include_deleted=true` and mark it "Deleted".
- **No new links.** A deleted contact cannot become a requisition's hiring manager, a company's billing
  contact, the owner of a new task, a saved-list entry, another contact's `reports_to_id`, or the company's
  primary contact, and no activity can be recorded against it. Each of these is refused with **422
  `CONTACT_DELETED`** (details: `contact_id`, `field`).
- **Deleted view.** Holders of `contact:delete` list deleted contacts with
  `GET /v1/contacts?paged=true&deleted=true`. Everyone else gets 403.
- **Restore** (`POST /v1/contacts/{id}/restore`, `contact:delete`) clears `deleted_at` and
  `deleted_by_id`. It does not make the contact primary again. Restoring a live contact is a no-op.
- **Import revert.** Reverting an import batch soft-deletes the contacts that batch created.
- **Audit.** Delete and restore each emit an audit event.

`left_company` (Former) and deletion are separate: Former describes the person, deletion removes the
record from use.

## Hiring manager

`Requisition.contact_id` is the requisition's **hiring manager** (`libs/requisition/prisma/schema.prisma`).
On requisition create, update and import, a non-null `contact_id` must be a contact in the tenant, at
the requisition's company, and not deleted. Otherwise the request is refused with 422:
`VALIDATION_ERROR` (reason `contact_not_found` or `contact_company_mismatch`) or `CONTACT_DELETED`.
`null` means no hiring manager and is always allowed. A requisition's company is set at create and
cannot be changed by update, so an existing hiring manager always belongs to the requisition's company.
The requisition detail page can change the hiring manager with the same company-filtered picker used
at create, under the requisition edit scope.

The check lives behind the `REQUISITION_HIRING_MANAGER_VALIDATOR` port in `libs/requisition`, bound in
`apps/api`.

## Billing contact

`Company.billing_contact_id` names the company's billing contact. It must be a live contact at that
company. A company being created has no contacts yet, so a non-null `billing_contact_id` on create is
refused (422 `VALIDATION_ERROR`); it is set by update once the contact exists. On update a new value is
checked through the `COMPANY_BILLING_CONTACT_VALIDATOR` port (bound in `apps/api`) and refused with 422
`VALIDATION_ERROR` or `CONTACT_DELETED`. An unchanged value is not re-checked.

## Company and company relationships

A contact hangs off `company.Company` through `company_id`. Company visibility decides contact
visibility. The company's relationships (`company.CompanyRelationship`: client, vendor, partner) are
read onto each contact as `relationship_types`; a contact has no relationship of its own. The company's
primary contact is the contact with `is_primary = true`.

## Activity history

Notes, calls and logged emails are recorded against a contact through the activity route
(`POST /v1/activities` with `subject_type = contact`, scope `activity:create`) and listed with
`GET /v1/activities?subject_type=contact&subject_id={id}` (scope `activity:read`). The contact drawer
shows this history. Recording requires the contact to be visible to the actor (404 otherwise) and not
deleted (422 `CONTACT_DELETED`); the history of a contact the actor cannot see is empty.

Each recorded interaction moves `Contact.last_activity_at` forward; a later timestamp always wins over
an earlier one. `last_activity_at` drives the "Going quiet" segment (no activity for 14 days, or never)
and the cold-call order.

## Separation from Sign

Aramo Sign keeps its own address book: `sign.SignContact` (a sender's saved contacts) and the
recipients on `sign.Signer` rows. Sign never reads ATS contacts and ATS never reads Sign contacts.
The `sign:contact:read` scope covers Sign's saved contacts and recent recipients only.

## Endpoints and scopes

| Route | Scope | Notes |
|---|---|---|
| `GET /v1/contacts` | `contact:read` | Plain list (`{items}`) or, with `paged=true`, the faceted directory page. `q` also needs `contact:search`; `deleted=true` needs `contact:delete`. |
| `GET /v1/contacts/{id}` | `contact:read` | 404 when deleted, unless `include_deleted=true`. |
| `POST /v1/contacts` | `contact:create` | 201. |
| `PATCH /v1/contacts/{id}` | `contact:edit` | Omitted field = unchanged; `null` clears. |
| `DELETE /v1/contacts/{id}` | `contact:delete` | Soft delete, 204. |
| `POST /v1/contacts/{id}/restore` | `contact:delete` | 200 with the contact. |

Paged-directory filters: `q`, `scope=mine`, `owner_id`, `relationship_role`, `preference`,
`company_id` (comma-separated lists where plural), `is_hot`, `is_primary`, `quiet`, `former` (only
Former contacts), `cold_callable` (contactable and with a work phone), `deleted`; sort by `name`,
`created_at` or `last_activity` with `dir`; keyset paging with `cursor` and `page_size`. Facet counts
(`relationship_role`, `preference`, `company`, `hot`, `quiet`, `former`, `primary`) and `total` are
computed over the base set and do not move as the selection filters change.

Every route also requires the tenant's `ats` capability. All writes validate their body
(unknown fields, email and UUID formats, lengths, vocabularies) and refuse with 400 `VALIDATION_ERROR`.
