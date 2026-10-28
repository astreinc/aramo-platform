# Runbook — Permanent encrypted database backups (M-A8)

**Governs:** `Aramo-Sign-Mobile-Amendment-M-A8-Account-Lifecycle-and-Permanent-Backups-v1_0-LOCKED.md` §1
(replaces M-A7 §2 / R-15). Evidence: `Aramo/documents/Aramo-M-A8-Recon-Backups-and-Account-Lifecycle-20261028.md` §1.
**Supersedes:** `RUNBOOK-backups-r15.md` (kept only as a pointer to this file).

**Status:** tooling, Terraform and CI are in the repo. **Nothing is applied, enabled or deleted** until
each M-A8 §4 checkpoint is approved:

| Checkpoint (M-A8 §4) | What | Section |
|---|---|---|
| 4.1 Terraform production apply | `infrastructure-backups/` against the exact reviewed plan | §4 |
| 4.2 Box enablement | `age` + recipients, `/etc/aramo/backup.conf`, timer, first run, first restore test | §5 |
| 4.3 Historical disposal (D3) | against the exact verified inventory sha256 | §10 |

---

## 1. Design in one page

```
box (daily 03:30 UTC timer, or `--label pre-<sha>` before a deploy)
  docker exec pg_dump -Fc ─► age -R <primary + break-glass recipients> ─► <db>.dump.age (0600, 0700 dir)
  pg_dumpall --roles-only --no-role-passwords ─► age ─► globals.sql.age
  manifest.tsv (sha256, size, counts)        heartbeat/<run_id>.json (OK|FAILED, counts)
        │  single PUT, --server-side-encryption aws:kms --ssekms-key-id <bucket key>, SHA-256 checksum
        ▼
s3://aramo-prod-db-backups-use1   (Object Lock on, no default retention; versioned; SSE-KMS; TLS-only)
  routine/  historic/  historic/env/   ── 30 days
  heartbeat/  restore-checks/          ── 400 days
        ▲                                   │
Mac: aramo-restore-test.sh (restorer)        └─ daily freshness Lambda ─► SNS ─► email
```

- **Two layers of encryption.** `age` on the box to public recipients whose identities never touch the
  box or AWS, then SSE-KMS with an Aramo-managed key. Nothing in AWS can read a backup's content.
- **Plaintext never touches disk** on the box: dumps and `.env` files stream straight into `age`.
- **Every upload names SSE-KMS and this bucket's key.** The bucket policy refuses any `PutObject`
  without both (a Null guard plus an equality check, so a correct upload always passes). Uploads are
  single PUTs (`aws s3api put-object`, at most 5 GiB) because an `UploadPart` carries no SSE header and is
  refused, which also means the writer never needs `kms:Decrypt`. Each upload asks S3 for a SHA-256
  checksum and compares it with the local file, so a successful upload is a verified copy.
- **Monitoring without alarm resources:** EventBridge (daily 08:00 UTC) → Lambda → SNS email. It alerts
  when the newest `routine/` manifest is older than 26 h, the newest heartbeat is not `OK`, or the
  newest PASS restore check is older than 35 days. It reads keys and metadata only.

## 2. Key custody (PO)

Two `age` identities, owned by the PO, in **two separate places**:

1. On the Mac (offline is better):
   ```bash
   age-keygen -o aramo-backup-identity-primary.txt
   age-keygen -o aramo-backup-identity-breakglass.txt
   age-keygen -y aramo-backup-identity-primary.txt      # → age1… (public)
   age-keygen -y aramo-backup-identity-breakglass.txt   # → age1… (public)
   ```
2. Store the primary in the password manager and the break-glass on an encrypted offline medium (or
   another custody place the PO names). Losing both makes every backup unrecoverable.
3. Put **both public recipients** in `/etc/aramo/backup-recipients.txt` on the box (`root:root 0644`).
   Every artifact is then decryptable by either identity. The scripts refuse a recipients file that
   holds an identity (`AGE-SECRET-KEY-…`).
4. Never copy an identity to the box. Bring one to the Mac only for a restore test or a restore.
5. Rotation: add the new recipient, keep the old identity until every artifact encrypted to it has
   expired (30 days, plus any legal hold).

## 3. Principals and permissions

| Principal | Where | May | May not |
|---|---|---|---|
| `aramo-prod-backup-writer` (IAM user, static key) | box, `/etc/aramo/backup.conf` `0600` (Lightsail has no instance role) | `PutObject` to `routine/`, `historic/`, `heartbeat/`; `ListBucket` on those prefixes; KMS `GenerateDataKey`/`Encrypt` via S3 for objects under those prefixes | read anything, delete anything, write any other prefix, use KMS outside S3 |
| `aramo-prod-backup-restorer` (IAM user) | Mac AWS profile | `GetObject`/`GetObjectVersion` on `routine/`, `historic/`, `legal-hold/`; `ListBucket`; KMS `Decrypt` via S3 for those prefixes; `PutObject` to `restore-checks/` (+ KMS `GenerateDataKey` for those reports only) | delete, write backups |
| `aramo-prod-backup-freshness` (Lambda role) | AWS | `ListBucket` on `routine/`, `heartbeat/`, `restore-checks/`; `GetObject` (HEAD) on `heartbeat/`, `restore-checks/`; `sns:Publish` to the alert topic | read any backup body; any KMS use |
| Account administrator | Mac | KMS key **administration** (no data use); Object Lock legal holds (§9); Terraform apply | decrypt or write backups through the key |

The KMS key policy pins every data-use grant to `kms:ViaService = s3.us-east-1.amazonaws.com` and to
`kms:EncryptionContext:aws:s3:arn` matching the object ARNs of that principal's prefixes (the bucket does
not use an S3 Bucket Key, so the context is the object ARN). No access key is created in Terraform.

## 4. Terraform apply (Mac only; checkpoint 4.1)

Never from the box (wrong AWS account; 403 on the state bucket). The root has its own state key
(`backups/terraform.tfstate`), so its apply can only change backup resources. No `-target`.

```bash
cd infrastructure-backups
cp terraform.tfvars.example terraform.tfvars     # set alert_email (PO confirms the address)
terraform init                                   # backend: aramo-terraform-state-prod / backups/terraform.tfstate
terraform plan -out backups.tfplan               # file the plan output in Aramo/documents/ for review
terraform apply backups.tfplan                   # only the reviewed plan file
terraform output
```

Review points before approving the plan:
- **Object Lock is enabled at creation and cannot be turned off.** Record that at the checkpoint.
- The plan creates only: the bucket and its 6 configuration resources, the KMS key + alias, 2 IAM users
  + 2 inline policies, the SNS topic + email subscription, the Lambda + role + policy + log group, the
  EventBridge rule + target + permission. No access keys, no secrets.
- `prevent_destroy` is set on the bucket and the key.

After the apply:
1. Accept the SNS confirmation mail at `alert_email`.
2. Create the access keys out of band:
   ```bash
   aws iam create-access-key --user-name aramo-prod-backup-writer     # → box, §5
   aws iam create-access-key --user-name aramo-prod-backup-restorer   # → Mac profile aramo-backup-restorer
   ```
3. In `~/.aws/config` / `credentials` add profile `aramo-backup-restorer` (region `us-east-1`) and export
   `BACKUP_KMS_KEY_ID=$(terraform output -raw backup_kms_key_arn)` when running restore tests.

The legacy `create_backup_iam_user` path in `infrastructure-lightsail/` (never-created bucket
`astre-aramo-backups`) was removed on 2026-10-28, after a `terraform plan` of that root, run from the Mac,
showed 0 backup resources in state (M-A8 §1.1.1).

## 5. Box enablement (checkpoint 4.2)

```bash
sudo apt install age                                        # 1.1.1 from the Ubuntu archive
sudo install -m 0644 -o root -g root /dev/stdin /etc/aramo/backup-recipients.txt <<'EOF'
# aramo backups — primary
age1…
# aramo backups — break-glass
age1…
EOF
sudo install -m 0600 -o root -g root /dev/stdin /etc/aramo/backup.conf <<'EOF'
BACKUP_S3_URI=s3://aramo-prod-db-backups-use1
BACKUP_KMS_KEY_ID=arn:aws:kms:us-east-1:<account>:key/<id>
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<writer key id>
AWS_SECRET_ACCESS_KEY=<writer secret>
EOF
sudo docker pull amazon/aws-cli:2.17.0                      # the box has no host aws CLI
cd /opt/aramo && git log --oneline -1                       # a commit that contains this tooling
sudo sh -c 'set -a; . /etc/aramo/backup.conf; set +a; deploy/backup/aramo-backup.sh --label first-run'
```

**GATE:** exit 0, 4 objects under `routine/<run_id>/`, `heartbeat/<run_id>.json`. Then run the first
restore test (§7) and file its report. Only then enable the timer:

```bash
sudo cp deploy/systemd/aramo-pg-backup.service deploy/systemd/aramo-pg-backup.timer \
        deploy/systemd/aramo-pg-backup-failed.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now aramo-pg-backup.timer
systemctl list-timers aramo-pg-backup.timer
```

The service runs the backup, then `aramo-backup-prune.sh` (local `routine/` and heartbeats kept 7 days;
S3 keeps 30). Any failure starts `aramo-pg-backup-failed.service` (`OnFailure=`), which uploads a FAILED
heartbeat; the freshness check then mails the PO. Test the alert path once with the administrator
credential: `aws lambda invoke --function-name aramo-prod-backup-freshness /dev/stdout`.

## 6. Pre-deploy backups and `.env` snapshots

Release windows use the same script (RELEASE-box.md STEP 2). **No plaintext `pre-<sha>-backup-*.sql`
is written any more.**

```bash
cd /opt/aramo
sudo sh -c 'set -a; . /etc/aramo/backup.conf; set +a; deploy/backup/aramo-backup.sh --label "pre-'"${TARGET_SHA:0:8}"'"'
```

Before **any** change to `/opt/aramo/.env`, take an encrypted snapshot instead of `cp .env …`:

```bash
sudo sh -c 'set -a; . /etc/aramo/backup.conf; set +a; deploy/backup/aramo-env-snapshot.sh --label "pre-<sha-or-change>"'
# → /var/backups/aramo-r15/env/env-<label>.age (0600) + s3://…/historic/env/env-<label>.age
```

At most the 3 most recent snapshots stay on the box; S3 keeps each for 30 days. To restore one (Mac):
`age -d -i <identity> env-<label>.age > .env`, then copy it to the box over SSH.

## 7. Restore test (Mac; mandatory)

```bash
export AWS_PROFILE=aramo-backup-restorer BACKUP_KMS_KEY_ID=<backup_kms_key_arn>
AGE_IDENTITY_FILE=~/path/aramo-backup-identity-primary.txt \
  deploy/backup/aramo-restore-test.sh s3://aramo-prod-db-backups-use1/routine/<run_id> \
  --report ~/aramo-restore-test-<run_id>.txt
```

It verifies sha256 and size against the manifest, restores every database into a throwaway
`pgvector/pgvector:pg17` container started with `--rm --network none` (erasure roles pre-created), compares
table and migration-ledger counts with the manifest, removes the container **and its anonymous volumes**,
and uploads the counts-only report to `restore-checks/<UTCts>-<run_id>.PASS.txt` (or `.FAIL.txt`) with
metadata `result=PASS|FAIL`. A run that dies early still uploads a FAIL report.

**When:** after the first production run, after any storage or script change, after the historic
migration (§10), and **at least monthly** (the freshness check alerts after 35 days without a PASS).
File the local report in `Aramo/documents/` as well. Exercise the break-glass identity at least once a
quarter.

## 8. Restore for real + deletion reconciliation

1. **Never restore straight into the live container.** Start a new standalone postgres container (same
   image, not a compose service) and restore into it:
   `PG_CONTAINER=<restored> AGE_IDENTITY_FILE=… deploy/backup/pg-restore.sh <…>/aramo.dump.age`
   (and the same for `aramo_intelligence`).
2. Reconcile privacy deletions executed after the backup (M-A8 §1.3.2). The ledger is the **current**
   database (read-only); `created_at` is the run's `manifest.tsv` value:
   ```bash
   deploy/backup/aramo-deletion-replay.sh --backup-created-at <created_at> \
     --source-container aramo-prod-postgres --db-container <restored> --plan ~/replay-plan.tsv
   ```
   - exit 0, `verdict=EMPTY`: nothing was executed after the backup (always the case while
     account-deletion execution is not activated). Continue.
   - exit 4, `verdict=REQUIRED`: run `--stage` (puts each request into the restored database as
     `EXECUTING`, with a `REPLAY_STAGED` event), then run the sign-service privacy execution worker
     against the restored database with `SIGN_PRIVACY_DELETION_EXECUTION_ENABLED=1` and no ingress, then
     `--verify`. Exit 0 = every replayed deletion is `COMPLETED`.
   The script refuses the live container (by name, the ledger's own container, or any compose service
   container).
3. Only after step 2 exits 0: switch the stack to the restored database (PO decision, recorded in the
   window report).

## 9. Legal hold (Object Lock)

The bucket has Object Lock with **no default retention**. A hold is placed per object **version** by the
PO from the Mac with the **account administrator** credential (there is no legal-hold IAM principal):

```bash
# the file was uploaded like any other (box: aramo-backup-encrypt-existing.sh --hold-ref <ref> …);
# its uploads.tsv lists key + VersionId
aws s3api put-object-legal-hold --bucket aramo-prod-db-backups-use1 \
  --key historic/<run_id>/<file>.age --version-id <VersionId> --legal-hold Status=ON
aws s3api get-object-legal-hold --bucket aramo-prod-db-backups-use1 --key … --version-id …
```

- A held version cannot be deleted by anyone, lifecycle included. When the 30-day rule expires the
  object, the held version becomes noncurrent and stays until the hold is lifted (`Status=OFF`); the
  1-day noncurrent rule then removes it.
- The restorer reads a held noncurrent version with
  `aws s3api get-object --bucket … --key … --version-id <VersionId> <file>.age`.
- Record every hold (reference, key, VersionId, reason, who asked) in `Aramo/documents/`.
- `legal-hold/` stays reserved: the bucket policy denies deletes there and the restorer can read it, but
  no principal writes it (writing needs bucket-key use, which only the writer and restorer have).

## 10. Historic plaintext files: one disposition each (M-A8 §1.4)

Inventory: `Aramo/documents/Aramo-M-A8-Historical-Backup-Inventory-20261028.tsv`
(sha256 `c66f6ddde76e023b305a0ae54fe4efb8af98e7203b00eb086b363076b25e2d7a`, 97 files). Tool:
`deploy/backup/aramo-historic-disposition.sh`.

1. **Plan + validate** (anywhere; read-only):
   ```bash
   deploy/backup/aramo-historic-disposition.sh plan --inventory inv.tsv --out disposition.tsv
   deploy/backup/aramo-historic-disposition.sh validate --inventory inv.tsv --manifest disposition.tsv
   ```
   Defaults: dumps and `.env` copies `D1>D3`; the newest pre-deploy `dump-main` and `dump-intelligence`
   (the current rollback baseline) `D2>D3` until the first encrypted routine backup and its restore test
   pass; the 3 non-dump `.sql` scripts `D3`. The live `/opt/aramo/.env` is not in the inventory and is
   never touched.
2. **D1 migrate** (box, root, after §5):
   ```bash
   sudo sh -c 'set -a; . /etc/aramo/backup.conf; set +a; deploy/backup/aramo-historic-disposition.sh migrate \
     --inventory inv.tsv --manifest disposition.tsv --record d1-record.tsv'
   ```
   Every source is re-hashed against the inventory first (a changed file stops the run). Dumps go to
   `historic/<run_id>/`, `.env` copies to `historic/env/<run_id>/`, each upload checksum-verified; the
   record lists key, VersionId and `verified=yes` per file. Sources are not modified.
3. **Restore test the migrated dump runs** (Mac, §7) with `--expect-tables` / `--expect-ledger` from the
   nearest routine run (historic dumps record no counts). Keep each PASS report.
4. **D3 retire** (box, checkpoint 4.3). Dry-run first, then execute against the exact inventory:
   ```bash
   deploy/backup/aramo-historic-disposition.sh retire --inventory inv.tsv --manifest disposition.tsv \
     --record d1-record.tsv --restore-pass <PASS report>… --log retire.log
   sudo deploy/backup/aramo-historic-disposition.sh retire … --execute-d3 \
     --inventory-sha256 c66f6ddde76e023b305a0ae54fe4efb8af98e7203b00eb086b363076b25e2d7a
   ```
   A file is retired only if its sha256 and size still equal the inventory, its D1 copy is verified, and
   (for dumps) a PASS report exists for its migrated run. D2 files need `--release-d2
   --routine-restore-pass <PASS report of a routine run>`. Deletion is `shred -u` (on SSD/ext4 this is
   best effort; the encrypted 30-day window is the real control). File `retire.log` (paths + sha256 only)
   in `Aramo/documents/`.

## 11. Local layout (box)

```
/var/backups/aramo-r15/                      root 0700
  routine/<UTCts>-<label>/{aramo,aramo_intelligence}.dump.age, globals.sql.age, manifest.tsv
  heartbeat/<run_id>.json                    (7 days locally)
  env/env-<label>.age                        (3 newest)
  historic/<UTCts>-d1-…/                     (D1 runs: *.age, manifest.tsv, uploads.tsv)
```

## 12. Proof in CI

`backup-tooling` job (`.github/workflows/ci.yml`, member of `deployment-gate`):
`deploy/backup/aramo-backup.test.sh` (real postgres; fake S3 that enforces the bucket policy: KMS header on
every put, heartbeats, restore leaves no volume, deletion replay against a ledger fixture),
`deploy/backup/aramo-historic-disposition.test.sh`, the freshness Lambda unit tests and
`terraform fmt`/`validate` of `infrastructure-backups/`. Locally without `age`:
`ARAMO_TEST_AGE_IMAGE=<image with age> bash deploy/backup/aramo-backup.test.sh`.
