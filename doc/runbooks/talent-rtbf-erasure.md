# Runbook — Manual Talent RTBF / Erasure (résumé object + attachment)

**Status:** operator procedure (go-live). **Owner:** platform/compliance on-call.
**Why this exists:** a verified right-to-be-forgotten request cannot be fully
honored by the product alone today. Deleting a `TalentRecord` cascades the
résumé **text** row but does **not** delete the résumé **file** in S3 and does
**not** clean up the `Attachment` rows (they reference the talent by `owner_id`,
a cross-schema UUID with no FK — Architecture §7.3). This runbook closes that
gap manually. See the register entry in
[../go-live-known-limitations.md](../go-live-known-limitations.md) (Talent →
"RTBF / talent erasure") and [ADR-0007](../adr/Aramo-ADR-0007-Talent-RTBF-Anonymization-v1_0-LOCKED.md).

> Scope: this erases the ATS-side résumé artifacts + ATS TalentRecord + the
> (now TalentRecord-keyed) consent-event ledger for a verified request. The Core
> Talent identity anonymization (ADR-0007 state machine) remains **out of scope**
> (a deferred build) — note it in the erasure record.

---

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

## Step 7 — Record what remains out of scope

In the erasure record, note the deferred items NOT cleared by this procedure:

- **Core Talent identity** (if `core_talent_id` was ever linked) — anonymization
  is the deferred ADR-0007 state machine; not erased here.
- **Consent audit trail** (`audit."ConsentAuditEvent"`) — retained under the
  audit-retention policy (see Step 5); erase only when the order requires it.

---

## Notes

- **Orphan sweep does NOT do this for you.** The S3 lifecycle `orphan-pending`
  rule only reaps objects whose upload was *never committed* to an attachment
  (≈24h). A committed résumé is tagged `committed` and is retained until its
  retention-policy lifecycle rule or an explicit deletion like this one.
- This is a destructive, multi-system operation. Capture the Step-1 worklist and
  the Step-5 verification output as the erasure evidence.
