# Aramo Sign — Document Retention, Export and Deletion Policy

| | |
|---|---|
| Document key | `sign.retention_policy` |
| Version | 0.1.0 |
| Status | **DRAFT — LEGAL-PENDING.** Not approved. The retention durations below are proposals; the definitive periods need legal approval. |
| Baseline | `Aramo-Sign-Commercial-Plans-Legal-Framework-Amendment-A1-v1_0-LOCKED` §3.D |

## 1. While the subscription is active

The organization's users can open and download their documents, signed copies, execution
certificates and signing activity, within their roles' permissions.

## 2. After the subscription ends

- New sending stops. Envelopes already sent can still be signed, and completed ones still complete.
- **Proposed export window: 90 days** after the effective termination date, unless a contract
  requires longer. During it the organization can download its completed documents and their
  evidence. The window is configurable (`SIGN_POST_TERMINATION_EXPORT_DAYS`) and is **not set**
  until this policy is approved; while it is unset, access after termination is not time-limited.
- The 90-day window is an access period, **not** a deletion deadline.

## 3. Signed documents and evidence

Completed documents, signing evidence, execution certificates and the signing ledger are **never
deleted automatically** because a subscription ends, a payment fails, or storage or an allowance is
used up. Their retention and deletion follow a separately approved schedule that considers
contracts, applicable law, evidence preservation, the organization's instructions and legal holds.
[Schedule to be approved.] The service has no automatic deletion job today.

## 4. Drafts and unfinished envelopes

Drafts and envelopes that were never completed may have their own retention period. [Proposed
periods to be approved.] Removing a draft document deletes its record and releases its storage;
it never affects a completed envelope.

## 5. Deletion, backups and recovery

When a retention period ends, eligible data is removed through a controlled process that accounts
for storage replicas, database backups and pending legal holds. Aramo will not claim immediate or
irreversible deletion that the infrastructure cannot substantiate. [Backup retention and the
deletion procedure to be documented.]

## Required legal review

- Retention durations for completed documents, evidence and audit records by jurisdiction and
  document type.
- The export window length and format.
- Legal-hold procedure.
- Backup retention and the deletion statement that can be made truthfully.
