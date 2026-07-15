# Runbook — Talent RTBF / Erasure (complete chain-erase)

**Status:** operator procedure (go-live). **Owner:** platform/compliance on-call.
**Why this exists:** a verified right-to-be-forgotten request must reach EVERY
place a talent's data lives — not just the résumé. Deleting a `TalentRecord`
cascades only its same-schema children (résumé **text**, field provenance,
reconcile-contradiction); it does **not** touch the S3 résumé **file**, the
`Attachment` rows, the ~20 cross-schema operational holders, the trust-side PII
(anchors, evidence payloads, verification rows), or the person's superseded
**husks** — all cross-schema UUID refs with no FK (Architecture §7.3). This
runbook closes the full gap. See the register entry in
[../go-live-known-limitations.md](../go-live-known-limitations.md) (Talent →
"RTBF / talent erasure") and [ADR-0007](../adr/Aramo-ADR-0007-Talent-RTBF-Anonymization-v1_0-LOCKED.md).

> **Preferred path — the `erase-talent` CLI (TR-15 B2).** This procedure is now
> automated by an admin command that runs the exact delete-pass below,
> child-before-parent, over the whole human:
> ```sh
> # DRY-RUN (default) — prints the per-table would-delete inventory, ZERO writes:
> node dist/apps/api/src/talent-anchor/erase-talent.command.js <TENANT_ID> <TALENT_ID>
> # LIVE — requires --execute AND re-typing the id as a confirmation string:
> node dist/apps/api/src/talent-anchor/erase-talent.command.js <TENANT_ID> <TALENT_ID> --execute <TALENT_ID>
> ```
> The CLI performs the DB deletes + appends the retained consent erasure marker +
> flips `is_anonymized`. It STUBS the S3 deletion (the app has no DeleteObject
> IAM): it prints the object keys; you still run Step 2 below with elevated creds.
> The manual SQL steps below remain the authoritative reference + the S3 procedure.

> Scope: this erases the ATS-side résumé artifacts, every operational + trust-side
> PII holder, the person's husk chain, and the (TalentRecord-keyed) consent-event
> ledger. RETAINED as the append-only **record of process**: the consent audit
> stream (`audit."ConsentAuditEvent"`) and the merge-operation audit
> (`talent_trust."SubjectMergeOperation"`) — see the audit-retention note.

---

## The erasure inventory (what the delete-pass covers)

Two keys: the **record id** (ATS `TalentRecord.id`, plus every husk) and the
**subject id** (trust `ResolutionSubject.id`, plus every merged-cluster member).
Resolve them first (husk chain via `superseded_by_record_id`; cluster via
`ResolutionSubjectRef` + `merged_into_subject_id`), then delete in this order —
**child-before-parent** (Group B has real FKs and no cascades, so the order is
DB-enforced):

**Group A — operational holders (keyed by the record id):**
`engagement."TalentSubmittalEvent"` → `engagement."TalentEngagementEvent"` →
`examination."ExaminationOverride"` (event children first) → `pipeline."Pipeline"`
(cascades its status history) → `engagement."TalentSubmittalRecord"` →
`evidence."TalentJobEvidencePackage"` → `engagement."TalentJobEngagement"` →
`examination."TalentJobExamination"` → the seven `talent_evidence.*` tables
(`TalentSkillEvidence`, `TalentWorkHistoryEntry`, `TalentContactMethod`,
`TalentRateExpectation`, `TalentWorkAuthorization`, `TalentDocument` [S3],
`TalentDerivedSnapshot`) → **`talent_evidence."TalentEducationEntry"` +
`"TalentCertificationEntry"`** (⚠ TR-15 B2 ADDITION — TR-7 B1 PII holders that are
NOT in the reconcile repoint set; a repoint-mirroring erase would leak them) →
`saved_list."SavedListEntry"` (`item_type='talent_record'`) →
`attachment."Attachment"` (`owner_type='talent'`, S3) → `activity."Activity"`
(`subject_type='talent_record'`) → `task."Task"` (`owner_type='talent_record'`) →
`consent."TalentConsentEvent"`. **Polymorphic discriminators are mandatory** —
note the drift: attachment uses `owner_type='talent'`, task/activity/saved-list
use `'talent_record'`.

**Group B — trust-side PII (keyed by the subject id; delete child-before-parent):**
`talent_trust."EvidenceEvent"` → `"EvidenceLink"` → `"EvidenceRecord"` →
`"SubjectAnchor"` (`normalized_value` is raw email/phone PII) → `"TrustState"` →
`"SubjectMatchAdvisory"` (match on either side) → `"VerificationRequest"` →
`"VerificationProposal"` → `"ResolutionSubjectRef"` → `"ResolutionSubject"` (LAST).

**Group C — the husk records (keyed by the record id):**
`talent_record."TalentRecord"` (every husk) — cascades `talent_resume_text` [S3],
`talent_record_field_provenance`, `talent_record_reconcile_contradiction`.

**S3 objects:** `attachment."Attachment".storage_key`,
`talent_evidence."TalentDocument".file_storage_ref`,
`talent_record."talent_resume_text".storage_key`.

**Then:** append the consent erasure marker (`audit."ConsentAuditEvent"`,
`event_type='consent.erased'`) — the retained record that erasure happened;
`is_anonymized` reads it and flips true.

**Identity-cluster last-reference purge (TR-2b B2b):** BEFORE the Group B delete,
the CLI captures the distinct `ref_id`s of the erased subjects'
`ref_type='PERSON_CLUSTER'` `ResolutionSubjectRef`s (they die in the generic
subject-keyed delete). AFTER the inventory, each captured `identity_index`
cluster is R4-liveness-checked **excluding** the erased subjects — a cluster still
referenced by another live tenant's subject SURVIVES; an **orphaned** cluster is
torn down by the one `purgeCluster` primitive (caller `erasure`): delete
`platform_trust."DormantLink"` → `identity_index."ClusterFingerprint"` →
`"PersonCluster"`, then null `ingestion."RawPayloadReference".resolved_cluster_id`
and `portal_identity."PortalUser".cluster_id`. **NO grace period on the erasure
path** (RTBF intent is explicit; D11) — unlike the daily lifecycle sweep's 30-day
orphan grace. A purged portal user re-links to a fresh cluster at their next
login (the login-time re-link). The dry-run reports the would-purge cluster
ids without purging.

---

## Manual SQL procedure (the CLI automates this; kept as the reference)

## Preconditions

- A **verified** erasure request (compliance gate — out of scope for this
  technical runbook; do not proceed without it).
- The **ATS `TalentRecord` id** (`talent_record.talent_record.id`) and its
  `tenant_id`. If you only have a name/email, resolve the id first via the
  recruiter console or a tenant-scoped DB read.
- DB read/write access to the `attachment` and `talent_record` schemas.
- AWS credentials with `s3:ListObjectVersions` + `s3:DeleteObject` +
  `s3:DeleteObjectVersion` on the résumé bucket `aramo-<env>-resumes`.
  ⚠️ The app's runtime IAM policy intentionally has **no** DeleteObject — this
  deletion is an operator action with elevated credentials, not an app path.

Set the working variables (example):

```sh
ENV=prod                       # dev | staging | prod
BUCKET=aramo-$ENV-resumes
TALENT_ID=<the talent_record.id, a UUID>
TENANT_ID=<the tenant_id, a UUID>
```

---

## Step 1 — Locate the résumé object key(s)

The S3 object key is the `Attachment.storage_key`. There is no S3 enumeration
by talent — the key lives in Postgres. Query the attachment rows for this
talent (note `owner_type='talent'`, the A4-wired enum):

```sql
SELECT id, storage_key, file_name, is_resume, created_at
FROM attachment."Attachment"
WHERE tenant_id = :TENANT_ID
  AND owner_type = 'talent'
  AND owner_id   = :TALENT_ID;
```

Record every `storage_key` returned (a talent may have multiple attachments;
`is_resume = true` marks résumés, but **erase all** the person's attachments for
a full RTBF). Keep this list — it is your deletion worklist and your audit
evidence.

## Step 2 — Delete the S3 object AND all versions

The bucket is **versioned** (recoverability for accidental delete). A plain
`aws s3 rm` only writes a delete-marker — the prior versions remain and the PII
is **not** erased. For RTBF you must delete every version + delete-marker of
each key.

For each `STORAGE_KEY` from Step 1:

```sh
KEY="<storage_key>"

# Enumerate every version + delete-marker for the key, then delete each.
aws s3api list-object-versions \
  --bucket "$BUCKET" --prefix "$KEY" \
  --query '{Objects: [].{Key:Key,VersionId:VersionId} || `[]`, DeleteMarkers: DeleteMarkers[].{Key:Key,VersionId:VersionId} || `[]`}' \
  --output json > /tmp/versions.json

# Delete object versions:
aws s3api list-object-versions --bucket "$BUCKET" --prefix "$KEY" \
  --query 'Versions[].{Key:Key,VersionId:VersionId}' --output json \
  | jq -c '.[]?' | while read -r v; do
      aws s3api delete-object --bucket "$BUCKET" \
        --key "$(echo "$v" | jq -r .Key)" \
        --version-id "$(echo "$v" | jq -r .VersionId)"
    done

# Delete the delete-markers:
aws s3api list-object-versions --bucket "$BUCKET" --prefix "$KEY" \
  --query 'DeleteMarkers[].{Key:Key,VersionId:VersionId}' --output json \
  | jq -c '.[]?' | while read -r v; do
      aws s3api delete-object --bucket "$BUCKET" \
        --key "$(echo "$v" | jq -r .Key)" \
        --version-id "$(echo "$v" | jq -r .VersionId)"
    done

# Verify the key is gone (expect empty Versions and DeleteMarkers):
aws s3api list-object-versions --bucket "$BUCKET" --prefix "$KEY" \
  --query '{V:Versions, D:DeleteMarkers}'
```

> Use an exact key prefix. If a `storage_key` is a prefix of another key, scope
> the match (e.g. confirm against the Step-1 list) so you do not over-delete.

## Step 3 — Delete the attachment rows

```sql
DELETE FROM attachment."Attachment"
WHERE tenant_id = :TENANT_ID
  AND owner_type = 'talent'
  AND owner_id   = :TALENT_ID;
```

## Step 4 — Delete the TalentRecord (cascades the résumé text)

Prefer the API (`DELETE /v1/talent-records/:id`, scope `talent:delete`) so the
existing not-found/tenant checks apply. The résumé-text row purges automatically
via the `ON DELETE CASCADE` FK (ADR-0015). If deleting directly in the DB:

```sql
DELETE FROM talent_record."TalentRecord"
WHERE tenant_id = :TENANT_ID AND id = :TALENT_ID;
-- talent_record.talent_resume_text cascades.
```

## Step 5 — Erase the consent-event ledger (Step-5 consent re-key)

The consent ledger is now keyed by `TalentRecord.id` (the same `:TALENT_ID` as
Step 4), so it is directly addressable here. It lives in a SEPARATE
schema/datasource with a UUID-only, no-FK cross-schema reference (Architecture
§7.3), so the Step-4 `TalentRecord` delete does **not** cascade into it — this
explicit DELETE is required. The ledger's immutability trigger blocks `UPDATE`,
not `DELETE`.

```sql
DELETE FROM consent."TalentConsentEvent"
WHERE tenant_id = :TENANT_ID AND talent_record_id = :TALENT_ID;
```

Forensic audit rows (`audit."ConsentAuditEvent".subject_id = :TALENT_ID`) are
retained under the audit-retention policy; delete them explicitly only when the
compliance order requires it.

> A programmatic erase hook (wiring this DELETE into the `DELETE
> /v1/talent-records/:id` path) is a deferred follow-up; today this is an
> operator SQL step.

## Step 6 — Verify

```sql
-- expect 0 rows for all four:
SELECT count(*) FROM talent_record."TalentRecord"       WHERE id = :TALENT_ID;
SELECT count(*) FROM talent_record."talent_resume_text" WHERE talent_record_id = :TALENT_ID;
SELECT count(*) FROM attachment."Attachment"
  WHERE owner_type='talent' AND owner_id = :TALENT_ID;
SELECT count(*) FROM consent."TalentConsentEvent"       WHERE talent_record_id = :TALENT_ID;
```

And re-run the Step-2 verify for each key (empty `Versions` + `DeleteMarkers`).

## Step 7 — The retained audit (record of process) + what remains out of scope

**Retained by design — the append-only record that erasure happened + why.**
These two audit streams are NOT deleted by this procedure (nor by the CLI). Their
PII scope is enumerated honestly so a reviewer knows exactly what persists:

- **`audit."ConsentAuditEvent"`** — the consent decision/process log, keyed by
  `subject_id = TALENT_ID`. After erasure it holds the historical
  grant/revoke/check rows (their `event_payload` JSONB carries scope + reason
  codes, and reconcile rows carry from/to record ids — no name/email/résumé) PLUS
  the new `consent.erased` marker row (payload: the record + subject id sets and
  the tables cleared). **PII scope: identifiers (UUIDs) + consent decisions, no
  résumé/name/contact content.** `is_anonymized` reads the marker and returns true.
- **`talent_trust."SubjectMergeOperation"`** — the merge/reversal audit, keyed by
  `surviving_/merged_subject_id` + `surviving_/superseded_record_id`. Its JSONB
  (`sweep_steps` / `ref_actions` / `collision_records`) may embed **row content
  captured at merge time** (potentially name/contact fields of a collided row).
  **PII scope: MAY contain contact-field content in `collision_records`** — if the
  order demands zero residual PII, delete the operation rows for these subjects
  explicitly; otherwise retain as the reversal/audit record.

Delete either stream explicitly **only** when the compliance order requires zero
residual identifiers — they are the forensic proof the erasure was performed.

**Deferred / out of scope:**

- **Core Talent identity** (if `core_talent_id` was ever linked) — anonymization
  is the deferred ADR-0007 state machine; not erased here.

---

## Notes

- **Orphan sweep does NOT do this for you.** The S3 lifecycle `orphan-pending`
  rule only reaps objects whose upload was *never committed* to an attachment
  (≈24h). A committed résumé is tagged `committed` and is retained until its
  retention-policy lifecycle rule or an explicit deletion like this one.
- This is a destructive, multi-system operation. Capture the Step-1 worklist and
  the Step-5 verification output as the erasure evidence.
