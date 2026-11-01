# Runbook — KMS evidence signing and artifact custody incidents

v1.0, 2026-11-01. Conventions (PGRO, container names): [README.md](README.md).
Governing directive: Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED (SX-1, SX-2;
LC-1, LC-3). Infrastructure: `infrastructure-lightsail/doc4-sign.tf`, `infrastructure-lightsail/sign-artifacts.tf`.

## 1. The moving parts

| Part | Production value (defaults in `infrastructure-lightsail/variables.tf`) | Used by |
|---|---|---|
| Evidence-signing key | `alias/aramo-sign-evidence`, RSA_2048, `SIGN_VERIFY` | sign-service, `SIGN_KMS_KEY_ID` (+ optional `SIGN_KMS_SIGNING_ALGORITHM`) |
| Artifact bucket | `aramo-prod-sign-artifacts-use1`: versioned, Object Lock enabled (no default retention, LC-1), SSE-KMS `alias/aramo-prod-sign-artifacts`, keys under `tenants/<tenant_id>/` | sign-service, `SIGN_ARTIFACT_BUCKET` |
| Sign-only IAM user | `aramo-sign-prod`; its key is `SIGN_ARTIFACT_AWS_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` in `/opt/aramo/.env` | KMS signing **and** S3 custody. The shared `AWS_*` key is never used for evidence signing (`signKmsClientFromEnv`). |
| Key administration | Only the break-glass principal (`var.break_glass_principal_arn`); **neither key policy has an account-root statement** — if that principal is lost, the keys cannot be administered | PO |
| Audit | CloudTrail `aramo-prod-sign-audit` (management events + S3 write data events for the Sign bucket) → `aramo-prod-sign-audit-logs-use1` | Investigations |

Behaviour (`apps/sign-service/src/app/kms-evidence-manifest-signer.ts`):
- **At boot** (`NODE_ENV=production`) sign-service calls `DescribeKey` and **refuses to start** unless the key
  is an enabled asymmetric `SIGN_VERIFY` key supporting the algorithm, and refuses to start without
  `SIGN_KMS_KEY_ID` or without the Sign-only credential. Symptom: `aramo-prod-sign` restart loop, log line
  `KMS evidence signing key refused: …` or `sign-service refuses to start: …` — and, because nginx resolves
  `sign-service` at config load, a **nginx recreate in that state crash-loops the whole front door**
  (`RELEASE-box.md` HARD STOPS).
- **At runtime** each evidence manifest (envelope completion, evidence download, custody of the evidence
  snapshot) is a KMS `Sign` call. A failure surfaces as `sign_artifact_custody.completion_failed …` or an
  HTTP 500 on the evidence route, matched by the `sign:kms` / `sign:custody` alerts.
- **Custody** (`custody/executed-artifact-custody.service.ts`): on completion each executed document,
  certificate and evidence snapshot is uploaded and its version id + SHA-256 recorded in the ledger. Bytes
  leaving PostgreSQL must match the recorded hash or custody is **refused**. Envelopes left without custody
  are retried by the reconcile job every 10 minutes (`SIGN_ARTIFACT_RECONCILE_INTERVAL_MS`, minimum 60 s),
  bounded per run.

## 2. Triage by symptom

| Symptom (alert or log) | Likely cause | Action |
|---|---|---|
| `aramo-prod-sign` restarting; `KMS evidence signing key refused: key state is Disabled/PendingDeletion` | Key disabled or scheduled for deletion | PO (break-glass, Mac): `aws kms describe-key --key-id alias/aramo-sign-evidence`. If `PendingDeletion`: `aws kms cancel-key-deletion --key-id <key id>` then `aws kms enable-key --key-id <key id>`. If `Disabled`: `aws kms enable-key`. Never create a new key and repoint `SIGN_KMS_KEY_ID` without the Lead: manifests signed by the old key must stay verifiable. |
| Restart loop; `…requires the Sign-only credential` or `AccessDeniedException` on `DescribeKey` | `SIGN_ARTIFACT_AWS_*` missing from `.env`, revoked, or rotated without updating the box | Check presence only: `sudo grep -c '^SIGN_ARTIFACT_AWS_ACCESS_KEY_ID=' /opt/aramo/.env` (never print values). Rotate per §4. |
| `sign:kms` alert, service up; `KMSInternalException` / throttling | Transient KMS error | Completion custody is retried by reconcile; watch for `sign_artifact_custody.reconcile … failed=0` on the next runs. Persisting > 1 h ⇒ AWS Health dashboard + escalate. |
| `sign:custody`: `upload_failed … error=AccessDenied` | Sign IAM policy or bucket policy drift | Compare `aws iam get-user-policy --user-name aramo-sign-prod --policy-name aramo-sign-prod-artifacts` with `sign-artifacts.tf` (Mac). Fix by Terraform (PO-authorized apply), never by hand in the console. |
| `sign:custody`: `reconcile … failed=N` repeating for the same envelopes | Persistent per-envelope failure | `docker logs --since 2h aramo-prod-sign 2>&1 | grep reconcile_envelope_failed` gives the envelope ids; run the validator (§3) for that tenant/envelope; escalate. |
| `sign:custody`: `ExecutedArtifactLedgerMismatchError` or `artifact bytes do not match the recorded sha256; custody refused` | The bytes in PostgreSQL no longer match the hash recorded at execution | **Integrity incident.** Stop; do not retry by hand. Follow [evidence-verification-and-disputes.md](evidence-verification-and-disputes.md) §5 (backup, notify PO + Lead, preserve objects, CloudTrail). |
| Validator reports `MISSING_CUSTODY` / `RECORD_MISMATCH` / `LEDGER_MISMATCH` / `CONTENT_MISMATCH` / `FETCH_FAILED` / `PURGE_INCOMPLETE` | See §3 | §3 |

## 3. Custody validator (read-only)

`apps/sign-service/src/ops/validate-artifact-custody.ts` (npm script `sign:validate-artifact-custody`):
for one tenant (optionally given envelopes) it reads the custody rows and ledger in a **read-only**
transaction, fetches every artifact **by version id** and checks SHA-256 against row and ledger. It writes
nothing to the database or S3.

```bash
# On the box, inside the running sign-service (it already has DATABASE_URL = the aramo_sign login
# and the SIGN_ARTIFACT_* settings). Path per the script header — confirm once with:
#   sudo docker exec aramo-prod-sign ls dist/apps/sign-service/src/ops/
sudo docker exec aramo-prod-sign node dist/apps/sign-service/src/ops/validate-artifact-custody.js \
  --tenant <tenant uuid> [--envelope <envelope uuid> ...]
echo "exit=$?"
```
**UNVERIFIED in production** (never run on the box). Output: one line per artifact, then
`[artifact-custody] OK|FAILED: checked=N <status>=<count> …`.

| Exit | Meaning |
|---|---|
| 0 | Every artifact `OK`, `PURGED` or `PURGE_WAITING_LOCK` |
| 1 | Any `MISSING_CUSTODY`, `RECORD_MISMATCH`, `LEDGER_MISMATCH`, `CONTENT_MISMATCH`, `FETCH_FAILED` or `PURGE_INCOMPLETE` |
| 2 | Fatal (no `DATABASE_URL`, no `SIGN_ARTIFACT_BUCKET`, bad arguments) |

| Status | Next step |
|---|---|
| `MISSING_CUSTODY` | Envelope not yet custodied: normal for up to one reconcile interval after completion; older ⇒ reconcile is failing (§2). |
| `FETCH_FAILED` | Credentials/bucket policy (§2) or a deleted version: check CloudTrail for `DeleteObjectVersion` on that key. |
| `CONTENT_MISMATCH`, `RECORD_MISMATCH`, `LEDGER_MISMATCH` | Integrity incident (evidence runbook §5). |
| `PURGE_INCOMPLETE` | A purge executed but versions remain; [purge-and-party-deletion.md](purge-and-party-deletion.md) §4. |

Not covered by the validator (script header): the delete-version / retention-bypass refusal checks of SX-2
item 8 — a separate checkpoint.

## 4. Rotating the Sign-only credential (planned window)

1. Mac (admin): `aws iam create-access-key --user-name aramo-sign-prod` (an IAM user holds at most 2 keys).
2. Box: encrypted `.env` snapshot first (`RELEASE-box.md` STEP 2, `deploy/backup/aramo-env-snapshot.sh`),
   then replace the two `SIGN_ARTIFACT_AWS_*` lines in `/opt/aramo/.env`.
3. Recreate sign-service only (this is a release window: `RELEASE-box.md` E22 rule applies):
   `set -a && source .env && set +a && docker compose -p aramo-singlebox -f docker-compose.prod.yml up -d --force-recreate sign-service`.
4. Verify: `aramo-prod-sign` healthy, no `KMS evidence signing key refused` in its log, `http:sign` OK.
5. Mac: `aws iam update-access-key --status Inactive` on the old key; delete it after 7 quiet days.

## 5. Never

- Never schedule deletion of, or disable, `alias/aramo-sign-evidence` or `alias/aramo-prod-sign-artifacts`.
  Executed artifacts and every past manifest depend on them.
- Never use Governance-bypass on the Sign bucket to "fix" custody.
- Never print or paste the Sign-only key; check presence with `grep -c`.
