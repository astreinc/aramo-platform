# SRC-1 — Ingestion Spine

Governing directives (OneDrive `Aramo/locked/`, canonical):
`Aramo-SRC-1-Directive-v1_0-LOCKED.md` and its amendment
`Aramo-SRC-1-Directive-Amendment-v1_1-LOCKED.md` (R13 storage shape; R5
signature annotation). Boundary: `Aramo-ADR-0019-Amendment-v1_1-Sibling-Deployable-LOCKED.md`.

SRC-1 is the ingestion spine of the sourcing track: the inbound path that turns a
first-party Indeed application into a talent arrival the tenant can promote. This
note records the shape of that spine so the next increments do not re-derive it.

## Two-surface layering (R1)

The audited name overload is resolved by keeping two surfaces distinct.

- **Document-arrival surface — `ingestion.RawPayloadReference`.** Every arrival that
  carries a payload (an application, a résumé document, a direct entry) enters
  through the existing sanctioned front door and remains the promotion source. A
  `SOURCED_TALENT` resolution ref targets a `RawPayloadReference.id`.
- **Channel dedup memory — `sourced_talent` (`libs/sourced-talent`).** One immutable
  row per `(tenant, channel, external_source_id)`. This is the tenant's memory of
  "which channel arrivals have we already seen", the substrate a later spend gate
  reads. It is referenced by its own key, not by a resolution ref, until a
  staging-only ref type lands (deferred to SRC-3).

A channel arrival that yields a document flows through **both**: a staging row for
the dedup memory, and the payload through the front door. Promotion is not
re-pointed and the forward identity writer is neither modified nor paralleled — the
"no parallel writer" rule.

## Write order (R4)

The Indeed apply webhook processes each delivery in this fixed order:

1. Verify the request signature (see below). Fail closed.
2. Resolve the tenant from the request Host slug. Unknown or inactive slug → 404.
3. Persist the raw signed bytes to object storage (R13) and compute the content
   hash server-side.
4. Call the front door in-process (channel `indeed`) — this writes the
   `RawPayloadReference`, storing the object by reference.
5. Record the channel arrival in the dedup memory, carrying the normalized contact
   fields and linkage provenance (the front-door payload id, the receipt time, the
   signature header name, and the applicant identifiers as received).

On a redelivery of the same `apply_id`, step 5 idempotently returns the original
row; the front door de-duplicates the identical bytes by content hash. Both are the
correct dedup-memory behaviour and are asserted end-to-end.

## Dark until a secret is configured

The webhook ships **dark by construction**. With no configured signature secret the
endpoint refuses all traffic (503). No Indeed partnership means no secret and no
posted jobs, so no live traffic reaches it until SRC-2 turns the flow on. Nothing in
SRC-1 waits on the partner timeline except real-traffic verification.

## Signature verification (R5) and the certification seam

The endpoint is the first signature-verified surface in the platform. The scheme is
the counterparty's, read from Indeed's partner documentation at build time: an
`X-Indeed-Signature` header carrying an HMAC-SHA1 of the full, unaltered request body,
Base64-encoded, keyed by the partner-provisioned secret. Verification is fail-closed
and constant-time (a length check precedes a constant-time compare).

Two rules protect this seam:

- **HMAC-SHA1 is the mandated algorithm.** It must not be unilaterally "upgraded" —
  doing so silently breaks verification against every real delivery.
- **The signed-bytes transform is a single named function.** The documentation shows
  one sample that Base64-encodes the body before the HMAC while the prose and the
  other samples hash the raw body directly; the canonical raw-body form is
  implemented and the ambiguity is recorded at the seam. **Pinning the transform
  against a real Indeed-signed sample is a hard SRC-2 exit criterion** — no tenant is
  onboarded to the Indeed apply flow before that verification passes.

## Storage shape (R13)

The object write is a single server-side primitive on the platform's existing object
client (no second storage adapter). Objects land under a reserved key prefix
`{tenant_id}/ingestion/{channel}/{external_source_id}/{receipt_uuid}.json`, storing the
raw signed bytes verbatim — the forensic artifact is exactly the byte sequence the
signature covered. A fresh receipt id per delivery keeps redeliveries as distinct
objects while the dedup memory remains the idempotency point. The content hash is
computed server-side. The existing document bucket is reused (its environment
variable name is retained rather than renamed); a dedicated bucket is a
counsel-driven decision about retention posture, not a tidiness one.

## `apply_id` scoping

The stable identifier in an Indeed application payload is the application id
(`apply_id`) — an application-instance id; the payload carries no
applicant-stable id. So the `(tenant, channel, external_source_id)` dedup key gives
**per-application** memory, which is exactly redelivery idempotency. **Person-level
memory is a different layer**: it is the normalized-contact fingerprint at admission,
not this key. A later spend gate that needs "is this human already in our book"
reads the fingerprint layer, never the channel key.

---

## Backlog

- **Enterprise Context v2.2** — the enterprise context document gains the webhook
  component and the solidified reads/promote edges **after SRC-2**, not per-PR. The
  spine is stable enough to document now; the reads/promote edges firm up once the
  flow is live.
