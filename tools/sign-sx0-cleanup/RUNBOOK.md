# SX-0 runbook: clean start of standalone Aramo Sign data

Governing: `Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED`, section SX-0, Lead Clarification LC-2.

**Status of authorization.** LC-2 authorizes the implementation, the read-only inventory, the dry-run and the validation tests. It does **not** authorize production execution. `execute` and `s3-execute` against production each need explicit written PO authorization naming the exact manifest SHA-256. Every production step below is a separate checkpoint.

## What the tool removes and keeps

**Selection.** A standalone envelope is a `sign."SignatureEnvelope"` with **no** `sign."EnvelopeDocument"` row whose `document_ref` is set. Every envelope with such a row is ATS-linked and is kept, with every row and stored object under it.

**Removed (the standalone tree), in this FK-safe order** (`TREE_STEPS` in `sx0.lib.ts`):

| # | Table | Predicate |
|---|---|---|
| 1 | SignPushJob | notification belongs to a removed envelope |
| 2 | SignUserNotification | `envelope_id` |
| 3 | SignNotificationOutbox | `envelope_id` |
| 4 | SignWebhookDelivery | `envelope_id` |
| 5 | NotificationDelivery | `envelope_id` |
| 6 | OutboxEvent | `event_payload->>'envelope_id'` |
| 7 | SignIdempotencyKey | operation `upload:<envelope_id>` / `remind:<envelope_id>` |
| 8 | IdempotencyKey | stored `response_body` names the envelope |
| 9 | SignAccessToken | `envelope_id` (EVENT_ARTIFACT grants only; STANDARD tokens have none) |
| 10 | ExecutedAccessGrant | `envelope_id` |
| 11 | ExecutedDocument | `envelope_id` |
| 12 | ExecutionCertificate | `envelope_id` |
| 13 | AbuseReport | `envelope_id` |
| 14 | SignRecipientBinding | `envelope_id` |
| 15 | SignerDisclosureAcceptance | signer belongs to a removed envelope |
| 16 | SigningSession | `envelope_id` |
| 17 | SignEnvelopeDocumentPages | document belongs to a removed envelope |
| 18 | SignatureField | document belongs to a removed envelope |
| 19 | EnvelopeDocument | `envelope_id` |
| 20 | Signer | `envelope_id` |
| 21 | SignatureEvent | `envelope_id` (append-only trigger disabled for this transaction only) |
| 22 | SignatureEnvelope | `id` |

**Kept, never touched:** SignSavedSignature, SignContact, SignNotificationPreference, SignPushDevice (user-level data); SignConvenienceDataPurge, SignConvenienceDeletionRequest, SignRetentionSweep (count-only audits); SignApplication, SignInstallation, SignCredential, SignRoleMapping, SignWebhookSubscription (tenant integration configuration); the `documents` schema; every other schema.

**Reported, not changed** (PO ruling: tenant, plan and billing records are kept). The inventory's `report.out_of_scope_references` counts the rows that will name a removed envelope afterwards:

- `subscription."AllowanceUsage"` rows with `send_key = 'aramo-sign:envelope:<id>'` (sent-envelope allowance usage). Period usage stays as charged.
- `subscription."CapacityUsage"` rows with `ref` `esign:executed:<ExecutedDocument.id>`, `esign:certificate:<envelope_id>` or `sign:object:<source_object_key>`, and their ACTIVE bytes. After the wipe these ACTIVE rows count storage that no longer exists, so the tenant's measured Sign storage reads high by that amount until a separately authorized correction.
- `signature_routing."SignatureRequestRoute"` rows whose `provider_envelope_ref` is a removed envelope id (expected 0: routes belong to ATS-sent requests).
- `metering."UsageEvent"` carries no envelope reference (count-only) and is not inspected.

**Triggers.** Only `signature_event_append_only` is disabled, inside the transaction, and re-enabled before commit (Postgres DDL is transactional, so any failure rolls the disable back too). `signature_envelope_deleted_final`, `signature_envelope_revision_bump` and `signature_envelope_template_provenance_immutable` are `BEFORE UPDATE` triggers; the child-row deletes only touch `revision_txid` on the envelope, which none of them refuse, so they stay enabled.

**S3.** All versions and delete markers under `esign/source/<tenant>/` whose key is not referenced by a retained envelope **and** does not sit under a retained envelope's path (two independent guards). Classification per key: `STANDALONE_REFERENCED`, `ORPHAN_OF_STANDALONE_ENVELOPE`, `ORPHAN_NO_ENVELOPE`. Nothing under `documents/` or any other prefix is ever listed or deleted.

## Running it

All modes: `node --import jiti/register tools/sign-sx0-cleanup/sx0.ts <mode> ...`, from a checkout of the merged commit, with `DATABASE_URL` pointing at the target database. `dry-run` and `execute` need a role that may `ALTER TABLE "sign"."SignatureEvent"` (the schema owner); `inventory` and `s3-inventory` only read.

| Mode | Reads | Writes |
|---|---|---|
| `inventory --tenant <uuid> --out m.json` | DB, one REPEATABLE READ READ ONLY transaction | the manifest file (0600) |
| `s3-inventory --manifest m.json --bucket <bucket> --out s3.json` | DB (read only) + `ListObjectVersions` | the S3 manifest file (0600) |
| `dry-run --tenant <uuid> --manifest m.json --out d.json` | DB | nothing: the whole delete runs, then ROLLBACK |
| `execute --manifest m.json --manifest-sha256 <sha> --confirm-tenant <uuid> --out e.json` + env `SX0_EXECUTION_AUTHORIZED=<sha>` | DB | the standalone tree, COMMIT |
| `s3-execute --s3-manifest s3.json --s3-manifest-sha256 <sha> --bucket <bucket> --out x.json` + env `SX0_S3_EXECUTION_AUTHORIZED=<sha>` | DB (read only) | `DeleteObjects` with `VersionId`, exactly the manifest pairs |

`execute` refuses (nothing changed) when: the manifest file's body does not hash to its recorded SHA or to `--manifest-sha256`; the env authorization does not name that SHA; the manifest is not tenant-scoped or `--confirm-tenant` differs; the executed-artifact immutability migration `20261031100100_sign_executed_artifact_immutability` is present (any trigger on `ExecutedDocument` / `ExecutionCertificate`, or its row in `public._local_migrations`: SX-0 must precede SX-1); `signature_event_append_only` is not enabled; or the inventory re-derived under `LOCK TABLE ... IN EXCLUSIVE MODE` differs from the frozen manifest in any way (envelope set, statuses, per-table counts, executed and certificate hashes, source keys, or the ATS-linked snapshot).

Inside the transaction it asserts: deleted rows per table equal the manifest counts; 0 standalone envelopes remain for the tenant; the ATS-linked snapshot (envelope ids, statuses, executed and certificate id+hash digests) is identical; every other sign table total is unchanged; the append-only trigger is enabled. Any failed assertion rolls everything back.

`s3-execute` refuses when the S3 manifest digest or authorization does not match, the bucket differs, any entry is outside `esign/source/<tenant>/`, contains `..`, or has no version id, when any manifest key is still referenced by an `EnvelopeDocument`, or when any key sits under an envelope that still exists (that is, before the DB wipe). The app principal `aramo-api-prod` has no delete right: `s3-execute` runs only under the admin principal, from the Mac.

## Preconditions (LC-2): return all of these before any destructive run

1. **Frozen inventory and counts.** `inventory --tenant <Astre tenant id>` run on the day; the manifest file and its SHA-256. Expected against F-5 to F-8: 25 standalone envelopes (8 COMPLETED, 2 SENT, 1 VOIDED, 14 deleted DRAFT), 8 standalone ExecutedDocument and 8 ExecutionCertificate rows, ATS-linked snapshot 10 envelopes (8 COMPLETED, 1 SENT, 1 DECLINED), 8 executed, 8 certificates. Any difference is reported, not reconciled silently.
2. **Exact S3 versions.** `s3-inventory` output: every key + version id + delete marker, its classification, and the excluded retained keys. Expected key count against F-10: 22 objects under `esign/source/`, 11 referenced; the retained (ATS-linked) keys must appear only under `excluded_retained_keys`.
3. **Dry-run.** `dry-run --manifest` on the same day, showing before/after counts and an identical live inventory SHA.
4. **Verified encrypted backup with restore evidence.** A fresh pre-wipe dump of the `sign` schema (`pg_dump --schema=sign -Fc`), encrypted and stored under the existing backup custody, plus evidence that it was restored into a scratch database and that the restored row counts equal the manifest's pre-wipe counts. This tool does not change backup handling.
5. **Send freeze** on standalone Sign traffic from the dry-run until SX-1 is applied.
6. **Written PO authorization** naming the manifest SHA-256 (DB) and, separately, the S3 manifest SHA-256.

## Execution (only after item 6)

1. Re-run `inventory` and confirm its SHA equals the authorized SHA (if not: stop, report the difference).
2. `SX0_EXECUTION_AUTHORIZED=<sha> ... execute --manifest m.json --manifest-sha256 <sha> --confirm-tenant <tenant> --out e.json`.
3. Verify independently with read-only SQL: 0 standalone envelopes for the tenant; ATS-linked 10 envelopes, 8 executed, 8 certificates; `signature_event_append_only` present with `tgenabled = 'O'`.
4. Only after step 3 is accepted: re-run `s3-inventory` against the post-wipe database and confirm it lists the same key/version pairs with the same classifications (classification comes from the frozen DB manifest, so it must not change). Obtain sign-off on that S3 manifest SHA.
5. Optional, recommended: copy every listed version to a sealed holding location under admin custody before deletion, because a version delete cannot be undone.
6. From the Mac, admin principal: `SX0_S3_EXECUTION_AUTHORIZED=<s3 sha> ... s3-execute ...`. It exits non-zero if any pair was not deleted.

## Rollback

- **DB, before commit:** automatic. Every refusal or failed assertion rolls the transaction back, including the trigger disable.
- **DB, after commit:** restore the `sign` schema from the pre-wipe dump (precondition 4) into the database during a maintenance window with sign-service stopped: `pg_restore --clean --if-exists --schema=sign`, then verify the restored counts against the manifest's pre-wipe numbers and confirm `signature_event_append_only` is enabled. Anything written to `sign` after the wipe is lost by this restore, which is why the send freeze holds until SX-1 is applied.
- **S3:** a version deleted with `VersionId` is **not recoverable** from the bucket. The only rollback is the holding copy from step 5. For that reason S3 deletion runs last, only after the DB result is verified and accepted, under its own authorization.

## Evidence to file (to `Aramo/documents`, never to `Aramo/locked`)

- The manifest JSON and SHA, the S3 manifest JSON and SHA (post-wipe re-run included).
- The dry-run output (`d.json`), the execute output (`e.json`) and the s3-execute output (`x.json`).
- The backup reference, its encryption and custody location, and the restore evidence.
- The PO authorization text naming both SHAs.
- The independent post-run SQL results (step 3) and the `report.out_of_scope_references` counts, flagged for the billing owner.

## Tests

`npx vitest run --config tools/vitest.config.ts sign-sx0-cleanup` runs the pure checks. With `ARAMO_RUN_INTEGRATION=1` (Docker required) it also runs `sx0.integration.spec.ts` on Postgres 17 with every `libs/sign` migration applied, against a fixture of standalone envelopes in each status and ATS-linked envelopes with executed rows.
