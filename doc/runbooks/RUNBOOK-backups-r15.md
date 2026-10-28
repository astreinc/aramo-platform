# Runbook — Encrypted database backups, restore tests and deletion replay (R-15)

**Governs:** `Aramo-Sign-Mobile-Amendment-M-A7-Google-Play-Compliance-and-Security-Remediation-v1_0-LOCKED.md`
§2 (SHA-256 `1db90858905a09d52fe4a1d01f25cdaa58228b8c9f7115e88003e6ecea36eaaf`), workstream WS-5.
**Evidence:** gap analysis G-1 (`Aramo/documents/Aramo-Sign-Android-Compliance-Audit-Gap-Analysis-vs-DocuSign-20261028.md`).
**Status:** tooling + Terraform authored. **Nothing is enabled on the box, nothing is applied, nothing
historic is deleted** until the PO actions in §7 are taken.

## 1. What changes

| Before (G-1) | After (R-15) |
|---|---|
| `pg_dump > /opt/aramo/*.sql` by hand at each deploy, plain SQL | `deploy/backup/aramo-backup.sh` streams `pg_dump -Fc` through `age`; no plaintext touches disk |
| Files `0644`/`0664`, directories `0755` | Files `0600`, directories `0700`, owned by root (the script refuses any other mode; it never chmods a directory it did not create) |
| Kept on the app server forever | Local copies pruned after 30 days (`aramo-backup-prune.sh`); off-server copy in an SSE-KMS bucket with a 30-day lifecycle |
| No manifest | `manifest.tsv` per run: sha256, size, db, timestamp, git SHA, table count, migration-ledger count |
| Restore tested once (Directive-3 drill) | `aramo-restore-test.sh` is mandatory after every storage change and on a schedule (§5) |
| A restore could resurrect deleted data | Deletion-replay gate (§6) |

## 2. Encryption design (why `age`)

- **Tool:** [`age`](https://age-encryption.org) 1.1.1 from the Ubuntu 24.04 archive (`apt install age`,
  one small static binary). X25519 key agreement + ChaCha20-Poly1305 (authenticated: a modified
  file fails to decrypt).
- **Public recipients on the box, private identities offline.** The box holds only `age1…`
  recipients (`/etc/aramo/backup-recipients.txt`). The scripts refuse a recipients file that contains
  an identity (`AGE-SECRET-KEY-…`). A compromised box can write new backups but cannot read any
  existing one.
- **Why not AWS KMS envelope encryption via an instance role:** Lightsail instances have no IAM
  instance profile; the box authenticates with static IAM-user keys. KMS envelope encryption would
  put decrypt authority in AWS (any principal with `kms:Decrypt` + `s3:GetObject` reads every
  backup) and make disaster recovery depend on the AWS account. With `age`, nothing in AWS can
  decrypt a backup, and a restore works offline.
- **Why not `gpg` (already installed):** keyring and trust-model state, more ways to misuse it
  (symmetric fallback, expiring subkeys); `age` has no configuration to get wrong.
- **Defence in depth:** the bucket also applies SSE-KMS with a dedicated, rotating key
  (`infrastructure-lightsail/r15-backups.tf`).

### Key custody (PO)

1. On the Mac (offline is better): `age-keygen -o aramo-backup-identity-primary.txt`, then
   `age-keygen -o aramo-backup-identity-breakglass.txt`.
2. Store the two identity files in **two separate custody locations** (e.g. the password manager and an
   encrypted offline medium). Losing every identity makes every backup unrecoverable.
3. Put **both public recipients** (`age1…`, printed by `age-keygen -y <file>`) in
   `/etc/aramo/backup-recipients.txt` on the box (`root:root 0644`). Every backup is then decryptable
   by either identity.
4. Never copy an identity to the box. Bring it to a host only for a restore, then remove it.
5. Rotation: add the new recipient, keep the old identity until every backup encrypted to it has
   expired (30 days + any holds).

## 3. Layout

Local (box): `BACKUP_DIR=/var/backups/aramo-r15` (root, `0700`)

```
routine/<UTCts>-<label>/aramo.dump.age               pg_dump -Fc | age
routine/<UTCts>-<label>/aramo_intelligence.dump.age
routine/<UTCts>-<label>/globals.sql.age              pg_dumpall --roles-only --no-role-passwords
routine/<UTCts>-<label>/manifest.tsv
historic/<UTCts>-<label>/…                           encrypted pre-R-15 dumps (migration, §8)
legal-hold/…                                         documented holds only; never pruned
```

S3 (`s3://aramo-prod-db-backups-use1`): the same `routine/`, `historic/`, `legal-hold/` prefixes.

| Prefix | Lifecycle | Who writes | Delete |
|---|---|---|---|
| `routine/` | expire after 30 days; noncurrent versions after 1 day | box writer | lifecycle only |
| `historic/` | expire after `r15_historic_retention_days` (PO; default 30) | box writer | lifecycle only |
| `legal-hold/` | none | PO admin from the Mac, with a recorded hold reference | denied to every principal by bucket policy; release = reviewed TF change |

## 4. Deploy backup (replaces RELEASE-box STEP 2's raw `pg_dump`)

```bash
cd /opt/aramo
sudo deploy/backup/aramo-backup.sh --label "pre-${TARGET_SHA:0:8}"
# prints the run directory on stdout; the per-database summary on stderr:
#   aramo.dump.age   db=aramo  bytes=…  tables=N  ledger=M
```

**GATE:** exit 0, and the summary shows each database with a non-zero byte count. The script already
fails closed on a failed `pg_dump`, an empty output, a missing database, an unsafe directory or a
recipients file holding a private key.

The script takes counts and ledger rows **before** `pg_dump` and outside its snapshot. Migrations
only run in STEP 3, after the backup, so the counts match the dump.

## 5. Restore test (mandatory)

Run on the **Mac** (it needs the identity), with the restore-reader credential
(`aramo-prod-backup-restorer`):

```bash
AGE_IDENTITY_FILE=~/path/aramo-backup-identity-primary.txt AWS_PROFILE=aramo-backup-restorer \
  deploy/backup/aramo-restore-test.sh s3://aramo-prod-db-backups-use1/routine/<run_id> \
  --report ~/aramo-restore-test-<run_id>.txt
```

It verifies sha256 and size against the manifest, restores every database into a throwaway
`pgvector/pgvector:pg17` container started with `--network none`, pre-creates the cluster roles
`aramo_erasure_definer`, `aramo_erasure_operator` and `aramo_intelligence`, restores with
`pg_restore --exit-on-error`, and compares base-table and migration-ledger counts with the manifest.
The report holds counts only. The decrypted stream is never written to disk; the container and temp
dir are removed on exit.

**When:** after any storage change (bucket, key, lifecycle, IAM, script change), after the first
enabled run, after the historic migration (§8), and at least monthly. File the report in
`Aramo/documents/`.

## 6. Deletion replay (restoring an older backup)

Contract (normative): `deploy/backup/aramo-deletion-replay.sh` header. In short:

1. Restore into a **non-serving** database (never straight into the live container).
2. Select every `DELETION` privacy request with status `COMPLETED` and `completed_at` later than
   the manifest's `created_at`, from the **current** privacy-request records (M-A7 §3, WS-4).
3. Re-run each through the same execution service in replay mode, idempotently, honouring §3.2
   retention exceptions and any legal hold.
4. Counts-only evidence; the database is returned to service only on exit 0.

**Today** the privacy-request records do not exist yet (WS-4). The hook **fails closed (exit 3)**.
Until WS-4 ships, a production restore needs an explicit PO decision that records which completed
deletions were re-applied and how.

## 7. Enablement (PO actions; none done by this workstream)

| # | Action | Where | Authority |
|---|---|---|---|
| E-1 | Generate primary + break-glass identities; store in two custody locations (§2) | Mac | PO |
| E-2 | `terraform apply` with `manage_r15_backups = true` (decide `r15_historic_retention_days`, `r15_object_lock_enabled` first) | **Mac only** | PO |
| E-3 | `aws iam create-access-key` for `aramo-prod-backup-writer` → `/etc/aramo/backup.conf` (`root:root 0600`); same for `aramo-prod-backup-restorer` → Mac profile | Mac → box | PO |
| E-4 | `sudo apt install age` on the box; write `/etc/aramo/backup-recipients.txt` | box | PO-authorized box change |
| E-5 | Pull the repo commit containing this tooling; first run `sudo deploy/backup/aramo-backup.sh --label first-r15` | box | PO-authorized |
| E-6 | Restore test of that run (§5); file the report | Mac | PO |
| E-7 | Enable `aramo-pg-backup.timer` (daily backup + local prune) if wanted | box | PO |
| E-8 | Historic migration (§8) | box + Mac | PO approval for every deletion |

The box has no AWS CLI on the host; the scripts fall back to the pinned `amazon/aws-cli:2.17.0`
image through docker (pull it during E-5).

## 8. Historic dumps (pre-R-15) — migration plan

Nothing is deleted without (a) an independent, restore-tested encrypted backup and (b) PO approval
(M-A7 §2, §8). Inventory and classification: `Aramo/documents/Aramo-Backup-Hardening-R15-Plan-and-Evidence-20261028.md`.

1. **Inventory** (done, read-only): filename, size, mtime, mode, owner, inferred database.
2. **Classify** (PO confirms):
   - **A — at most 30 days old:** inside the baseline. Encrypt-and-upload to `historic/` only if the
     PO wants them kept until they age out; otherwise they are eligible for deletion as soon as a
     restore-tested R-15 routine backup exists.
   - **B — older than 30 days:** outside the baseline. Eligible for deletion once a restore-tested R-15
     routine backup exists, unless the PO or counsel records a hold.
   - **C — special:** for example the ATI-SEP-1 dropped-schema dump. Lead / PO decide hold or delete.
   - **Hold:** anything the PO or counsel places on hold is encrypted to `legal-hold/<ref>/` with
     the hold reference recorded.
3. **Encrypt-and-upload** what is kept:
   `sudo deploy/backup/aramo-backup-encrypt-existing.sh --class historic --label <set> <files…>`.
   The script records each source's sha256, size and mtime and never modifies a source.
4. **Verify:** `aramo-restore-test.sh` on the uploaded run, with `--expect-tables` / `--expect-ledger`
   (historic dumps have no recorded counts; use the counts of the nearest routine run).
5. **Delete (PO approval only):** for each approved file, compare its sha256 with the manifest's
   `source_sha256`, then `shred -u` (or `rm`) it. Record the counts-only disposition in
   `Aramo/documents/`.
6. **Mac copies (`~/.aramo-e1-backups`):** the same steps from the Mac. That directory also holds
   two `.env` copies. Those are secret material, not database backups; their disposition is the
   key-custody follow-up, not R-15.
