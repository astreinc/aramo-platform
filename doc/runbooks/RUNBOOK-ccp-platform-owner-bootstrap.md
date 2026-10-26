# Runbook — CCP platform-owner bootstrap (A9, the one-time D7 command)

> **Design approval is not production migration authority (ruling A0-C15).** This command is a
> **production write**. It **must never run against production without explicit PO authorization**
> for that run (T2-F1-H3 Amendment A1, A1-2(7): "Running the command against production is a production
> write. It SHALL be authorized separately by the PO"). Approval of CCP-A9 is not that authorization.

**Status:** operator procedure (CCP-D5). **Owner:** the PO (authorizes and is the attesting operator); a
platform engineer with box access (executes).
**Governing text:** `Aramo-T2-F1-H3-Production-Platform-Owner-Bootstrap-Directive-Amendment-A1-CCP-Confirmation-v1_0-LOCKED.md`
A1-1, A1-2, A1-4, §6; Program Build Directive §5.1 row A9, §7.6, §12. **Code:** `libs/subscription/scripts/ccp-bootstrap-platform-owner.ts`,
`libs/subscription/src/lib/commercial/commercial-platform-owner-bootstrap.ts`.
**Dry run:** `doc/ccp/runbook-dry-runs-20261025.md` §4.

## 1. D5-DEF-3 — FIXED (CCP-FIX1)

The defect: `npm run ccp:bootstrap-platform-owner` runs the script through `deploy/jiti-tsconfig-runner.mjs`, which
leaves the script path at `process.argv[2]`. The script parsed `process.argv.slice(2)`, so every invocation was
refused `INVALID_ARGUMENT` (fail closed, nothing written).

**Fixed by CCP-FIX1** (`doc/ccp/slices/CCP-FIX1-acceptance.md` §1): `scriptArgs()`
(`libs/subscription/scripts/ccp-bootstrap-platform-owner.ts:28`, used at `:39`) takes the arguments after the
script's own entry in `argv`, the rule the CCP-A11 scripts use. The CLI path is now proven through the real runner
by `libs/subscription/src/tests/ccp-fix1-script-runner.integration.spec.ts`:
- FIX1-RUN-1: an invalid invocation is refused `INVALID_ARGUMENT` (exit 2), naming the bad flag, never the entry
  path, and writes nothing;
- FIX1-RUN-2: a valid invocation grants platform_owner (exit 0, one audit event), and a re-run is a no-op.

This section is no longer a HALT. Every production run still needs its own PO authorization (§3, §4).

## 2. What the command does

It grants exactly `platform_owner` to the single T2-F1-H3 `:28` operator (`purush@aramo.ai`, the super_admin of the
platform sentinel tenant `01900000-0000-7000-8000-000000000100`) and records that operator's D9 attestation, in one
transaction under `pg_advisory_xact_lock(hashtextextended('ccp:bootstrap:platform_owner', 0))`. It takes **no user,
email, tenant or role argument**, creates no user, membership, tenant, credential or Cognito object, and is never
called by `deploy/seed-prod.sh` (A1-2).

Writes, all in that transaction:
1. one `identity."UserTenantMembershipRole"` row (platform_owner) with a deterministic id;
2. one `subscription."CommercialOperatorAttestation"` (method BOOTSTRAP, self-attested), unless an active one exists;
3. one `subscription."CommercialAuditEvent"`: `COMMERCIAL_PLATFORM_OWNER_BOOTSTRAPPED`, `is_exception = true`,
   `actor_type system`, payload `exception_kind BOOTSTRAP`, `granted_source MIGRATION`, `po_authorization_ref`,
   `executed_by`, the target and the instrument id.

After the first grant it is **permanently inert** (A1-2): a re-run is a no-op while the operator holds the role, and is
refused `ALREADY_BOOTSTRAPPED` once a bootstrap event exists.

## 3. Preconditions (all read-only checks; HALT on any miss)

1. A recorded PO authorization for this production run.
2. The 29 CCP migrations are applied and post-checked (`RUNBOOK-ccp-migration-validation.md` §5, stop point
   `20261030010000_ccp_c8pr_payment_record`). In particular
   an ACTIVE commercial policy exists: without it the command stops `FATAL` (exit 1) before its transaction.
3. D5-DEF-3 is fixed (§1: fixed by CCP-FIX1; the deployed build must carry that fix).
4. The checks below match:

```bash
sudo docker exec -i aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
BEGIN TRANSACTION READ ONLY;
-- the one T2-F1-H3 :28 operator: super_admin in the platform sentinel tenant (expect exactly 1)
SELECT count(*) AS super_admin_holders,
       count(*) FILTER (WHERE u.is_active AND m.is_active) AS active_holders
  FROM identity."UserTenantMembershipRole" r
  JOIN identity."UserTenantMembership" m ON m.id = r.membership_id
  JOIN identity."User" u ON u.id = m.user_id
  JOIN identity."Role" ro ON ro.id = r.role_id
 WHERE m.tenant_id = '01900000-0000-7000-8000-000000000100' AND ro.key = 'super_admin';
-- platform_owner holders (expect 0 before the bootstrap)
SELECT count(*) AS platform_owner_holders
  FROM identity."UserTenantMembershipRole" r JOIN identity."Role" ro ON ro.id = r.role_id
 WHERE ro.key = 'platform_owner';
-- the bootstrap has never run (expect 0 / 0)
SELECT (SELECT count(*) FROM subscription."CommercialAuditEvent" WHERE event_type = 'COMMERCIAL_PLATFORM_OWNER_BOOTSTRAPPED') AS bootstrap_events,
       (SELECT count(*) FROM subscription."CommercialOperatorAttestation" WHERE method = 'BOOTSTRAP') AS bootstrap_attestations;
-- an ACTIVE commercial policy exists (expect 1)
SELECT count(*) AS active_policies FROM subscription."CommercialPolicyVersion" WHERE status = 'ACTIVE';
-- the platform last-owner guard is armed (expect 5 rows, all A)
SELECT tgname, tgenabled FROM pg_trigger WHERE tgname LIKE 'ccp_a9_platform_last_owner_%' AND NOT tgisinternal ORDER BY 1;
ROLLBACK;
SQL
```

Expect `super_admin_holders = 1` and `active_holders = 1` (A1-1); `platform_owner_holders = 0`;
`bootstrap_events = 0`, `bootstrap_attestations = 0`; `active_policies = 1`; 5 triggers, all `A`.

5. The human reference hash. The attesting operator chooses the reference privately and supplies only its
   lowercase SHA-256 hex (64 characters). The reference itself is never written down in the evidence:

```bash
printf '%s' '<the operator's private human reference>' | shasum -a 256 | cut -d' ' -f1
```

## 4. Run (only with the PO authorization; D5-DEF-3 is fixed, §1)

From `/opt/aramo`, in the box form used by `deploy/seed-prod.sh` (node container on the compose network; `DBURL`
as in `RUNBOOK-ccp-migration-validation.md` §3 P3, never echoed):

```bash
sudo docker run --rm --network aramo-singlebox_default -v /opt/aramo:/repo -w /repo -e DATABASE_URL="$DBURL" \
  node:22-bookworm npm run -s ccp:bootstrap-platform-owner -- \
  --po-authorization-ref "<PO authorization reference>" --human-ref-hash <64 lowercase hex>
unset DBURL
```

| Outcome | Output | Exit |
|---|---|---|
| granted | `[ccp-bootstrap] granted platform_owner to <user>; attestation <id>; audit event <id>.` | 0 |
| already the operator's role | `[ccp-bootstrap] no-op: <user> already holds platform_owner (nothing written).` | 0 |
| refused | `[ccp-bootstrap] REFUSED: <code> <detail>` | 2 |
| error | `[ccp-bootstrap] FATAL: <message>` (for example no `DATABASE_URL`, or no ACTIVE policy) | 1 |

## 5. Refusals

| Code | Meaning | Operator action |
|---|---|---|
| `INVALID_ARGUMENT` | an unknown, duplicate or empty flag; a missing flag; `po_authorization_ref` not 3–500 characters; `human_ref_hash` not 64 lowercase hex | correct the invocation; never add a target argument |
| `TARGET_NOT_FOUND` | no user `purush@aramo.ai` with super_admin in the sentinel tenant | HALT; A1-1 is broken; do not create one |
| `TARGET_AMBIGUOUS` | more than one holder matches | HALT; A1-1 says exactly one |
| `TARGET_INACTIVE` | the operator's user or membership is inactive | HALT; the PO decides |
| `ALREADY_BOOTSTRAPPED` | a bootstrap event already exists (the command is inert) | stop; further owners come only through ROLE_GRANT |
| `OTHER_PLATFORM_OWNER_EXISTS` | someone else already holds platform_owner | HALT; investigate how (A1-0 forbids any seed grant) |
| `HUMAN_REF_IN_USE` | another account already attests this human reference | HALT; one human, one attestation |

## 6. After the run

Re-run the §3 checks: `platform_owner_holders = 1`, `bootstrap_events = 1`, `bootstrap_attestations = 1`, triggers
unchanged; read the audit row:

```bash
sudo docker exec aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT event_type, is_exception, actor_type, payload->>'\''exception_kind'\'' AS kind, payload->>'\''po_authorization_ref'\'' AS po_ref, payload->>'\''granted_source'\'' AS source FROM subscription.\"CommercialAuditEvent\" WHERE event_type = '\''COMMERCIAL_PLATFORM_OWNER_BOOTSTRAPPED'\''"'
```

From then on the platform must keep at least one effective platform_owner (A1-4; the guard and its break-glass are in
`RUNBOOK-ccp-break-glass.md` Part B). Record the PO authorization, the precheck and postcheck outputs and the command
output in the evidence folder. The command has no database-URL guard of its own (unlike the A11 tools): the PO
authorization and the operator are the only control on where it runs.
