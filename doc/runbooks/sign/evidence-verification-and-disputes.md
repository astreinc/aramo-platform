# Runbook — Signer disputes and evidence verification

v1.0, 2026-11-01. Conventions (PGRO, container names): [README.md](README.md).

Use when a signer says "I did not sign this", a sender or a third party asks Aramo to confirm an
envelope's evidence, or a legal request names an envelope. Aramo **reports what the evidence shows**;
it does not decide the dispute. Every step is read-only.

## 1. What evidence exists

| Evidence | Where | Source |
|---|---|---|
| Event ledger: every lifecycle event, each hashed over the previous hash (tamper-evident chain) | `sign."SignatureEvent"` (`previous_event_hash`, `event_hash`); append-only by trigger | `libs/sign/src/lib/hash-chain.ts` |
| Redaction records: events whose personal data a purge removed, with the original hash | `sign."SignatureEventRedaction"` (`original_event_hash`, `verified_before_redaction`) | Retention and Purge directive LD-2 |
| Evidence manifest: envelope id, source and executed hashes, event-chain hash, disclosure hash, signers, completion time, **signed with the KMS asymmetric key** | `GET /v1/sign/sender/envelopes/:id/evidence` (sender console, `sign:envelope:read` scope) | `libs/sign/src/lib/esign.service.ts` `evidenceManifest`, `apps/sign-service/src/app/kms-evidence-manifest-signer.ts` |
| Executed documents + execution certificate, custodied in S3 by object **version id** with the hash recorded in the ledger | Sign artifact bucket (`infrastructure-lightsail/sign-artifacts.tf`) | `custody/executed-artifact-custody.service.ts` |
| Disclosure acceptance per signer (consent version, text hash) | `sign."SignerDisclosureAcceptance"` | — |

## 2. Chain statuses (`verifyEventChain`, `libs/sign/src/lib/hash-chain.ts`)

Every event's `previous_event_hash` must equal the prior event's stored hash (the **link**), in chain
order `(occurred_at, id)`. Per event:

| Status | Meaning | What to say |
|---|---|---|
| `VERIFIED` | The stored hash recomputes from the stored row | The event is exactly as recorded. |
| `REDACTED_ATTESTED` | Personal data was removed by a purge; the stored hash equals the hash recorded at redaction, and the event recomputed **before** redaction | The event is intact; its personal fields were removed under retention. Integrity was proven at the moment of redaction. |
| `REDACTED_LINK_ONLY` | As above, but the event could not be recomputed before redaction (an event written before the jsonb-order change) | Link intact; content integrity rests on the chain link and the redaction record only. |
| `LINK_ONLY` | Not redacted, link intact, but the hash does not recompute from the stored payload | **Expected only for events written before the LD-2 jsonb-order change** (merged in #1044 and deployed with `06372585` on 2026-10-31 per the deployment record — UNVERIFIED here). On an event written **after** that deployment, `LINK_ONLY` means the stored payload no longer produces its hash: treat it as possible tampering and escalate (§5). The integration spec `apps/sign-service/src/tests/sign-retention-purge.integration.spec.ts` ("a tampered event is never reported VERIFIED") shows a tampered payload reports exactly this status. |
| `BROKEN` | A link break, or a redaction record that does not match the event | Integrity failure. Escalate immediately (§5). |

`ok` is true only when nothing is `BROKEN`; every other status is counted and reported, never folded into
`VERIFIED`.

## 3. Procedure

1. **Identify** the envelope id and tenant. Confirm the requester may see it (the sender's own tenant, a
   signer of it, or a legal request routed by the PO). Record the request in `Aramo/documents/`.
2. **Status and purge state** (a purged envelope has no documents; its ledger remains):
   ```bash
   PGRO -v env=<envelope uuid> <<'SQL'
   SELECT id, tenant_id, status, completed_at, purge_state, purge_level, purge_executed_at
     FROM sign."SignatureEnvelope" WHERE id = :'env';
   SQL
   ```
3. **Chain links** (read-only SQL; detects link breaks and redaction-record mismatches, i.e. the
   `BROKEN` cases):
   ```bash
   PGRO -v env=<envelope uuid> <<'SQL'
   WITH e AS (
     SELECT id, occurred_at, event_type, actor_type, previous_event_hash, event_hash,
            lag(event_hash) OVER (ORDER BY occurred_at, id) AS prior_hash
       FROM sign."SignatureEvent" WHERE envelope_id = :'env')
   SELECT e.occurred_at, e.event_type, e.actor_type,
          (e.previous_event_hash IS NOT DISTINCT FROM e.prior_hash) AS linked,
          r.event_id IS NOT NULL                                     AS redacted,
          r.verified_before_redaction,
          CASE WHEN r.event_id IS NULL THEN NULL ELSE r.original_event_hash = e.event_hash END AS redaction_record_matches
     FROM e LEFT JOIN sign."SignatureEventRedaction" r ON r.event_id = e.id
    ORDER BY e.occurred_at, e.id;
   SQL
   ```
   Any `linked = f` or `redaction_record_matches = f` ⇒ `BROKEN` ⇒ §5.
4. **Content recomputation** (`VERIFIED` vs `LINK_ONLY`) needs the hash function in code
   (`computeEventHash` with `jsonbCanonical`). **There is no operator CLI for `verifyEventChain` today**:
   it is called only from tests. Until one exists (open item, §6), report the link result from step 3
   and state that per-event recomputation was not run. Do not hand-reimplement the hash in a one-off
   script for a dispute; a wrong reimplementation would produce a false `LINK_ONLY`.
5. **Evidence manifest and KMS signature.** The sender (or the PO, with the sender's consent) downloads
   the manifest from the Sign app (`GET /v1/sign/sender/envelopes/:id/evidence`). The manifest carries
   `signature`, `signature_algorithm` (`KMS:<algorithm>`) and `kms_key_version_ref`. The service verifies it
   with KMS `Verify` (`KmsEvidenceManifestSigner.verify`) or offline against the public key
   (`verifyKmsEvidenceSignatureWithPublicKey`, exported by `@aramo/sign`). An independent verifier needs the public key:
   ```bash
   # Mac, as the break-glass principal: the evidence key policy grants kms:GetPublicKey / kms:Verify
   # only to that principal and to the Sign IAM user (sid BreakGlassVerifiesEvidence,
   # infrastructure-lightsail/sign-artifacts.tf). Public half only; never a private operation.
   aws kms get-public-key --key-id alias/aramo-sign-evidence --query PublicKey --output text | base64 -d > aramo-sign-evidence.der
   ```
   (alias from `infrastructure-lightsail/doc4-sign.tf`; output `sign_kms_key_id`). The exact canonical
   bytes signed are produced by `canonicalEvidenceManifestBytes` (`libs/sign/src/lib/ports/evidence-manifest-signer.port.ts`), then digested with the algorithm's hash and signed as `MessageType: DIGEST`; an external verifier
   must reproduce them from that function. **UNVERIFIED:** no external verification has been rehearsed.
6. **Executed document integrity.** Run the custody validator for the tenant and envelope; it fetches each
   artifact by version id and checks its SHA-256 against the row and the ledger (read-only):
   [kms-and-custody-incidents.md](kms-and-custody-incidents.md) §3. `OK` for each artifact = the stored
   document is byte-identical to what was executed.
7. **Report** (template below) to the PO. The PO decides what is shared with whom.

```
Envelope <id> (tenant <id>), status <status>, completed <ts>, purge_state <state>
Chain links: <n> events, <n> linked, <n> redacted (<n> record matches); BROKEN: none | <event ids>
Content recomputation: not run (no operator tool) | <counts per status>
Evidence manifest signature: verified by <KMS Verify | public key> at <ts> | not checked
Custody validator: OK=<n> PURGED=<n> … (exit <code>)
Prepared by <operator> on <date>; no data was changed.
```

## 4. Common dispute answers

- "I never received it": [stuck-envelopes.md](stuck-envelopes.md) §1 — `NotificationDelivery` shows when
  each invitation was sent; the ledger shows views (`event_type` values) and the signing session.
- "Someone else signed": the ledger records the signing events with `actor_type` and the request's IP
  address and user agent (`SignatureEvent.ip_address`, `user_agent`; these are personal data — share only
  through the PO). Aramo does not judge identity beyond what the envelope required.
- "The document was changed after I signed": steps 3, 5 and 6. Matching hashes in the manifest, ledger
  and custodied object answer it.

## 5. Escalation (BROKEN, or LINK_ONLY on a post-LD-2 event)

1. Stop. Do not run anything that writes. Take an encrypted backup now so the current state is preserved:
   `RELEASE-box.md` STEP 2 (`deploy/backup/aramo-backup.sh --label dispute-<envelope8>`).
2. Notify the PO and Lead Architect with the step-3 output.
3. Preserve the custodied objects: ask the PO to place an S3 Object Lock legal hold on the envelope's
   artifact versions (the same mechanism as `RUNBOOK-backups.md` §9, on the Sign artifact bucket).
   **UNVERIFIED** on the Sign bucket: confirm the legal-hold permission of the admin principal first.
4. Check CloudTrail (`aws_cloudtrail.sign_audit`, `infrastructure-lightsail/sign-artifacts.tf`) for writes to
   the artifact bucket around the event times.

## 6. Open items

- An operator CLI `sign:verify-event-chain` (read-only, same shape as
  `apps/sign-service/src/ops/validate-artifact-custody.ts`) that loads an envelope's events and redactions
  and prints the per-status counts of `verifyEventChain`. Needs a directive.
- A documented, rehearsed external verification of the KMS manifest signature.
