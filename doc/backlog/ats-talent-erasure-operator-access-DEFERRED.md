<!--
Filed to doc/backlog by the Code Executor on PO instruction (2026-10-31: "write a detail backlog
in the doc/backlog and we will revisit when we focus on the ATS").
STATUS: BACKLOG / DEFERRED — NOT implementation authorization.
-->

# ATS talent erasure: operator login and operator access (DEFERRED)

| | |
|---|---|
| Status | **Deferred by PO decision, 2026-10-31**, during the Aramo Sign production launch run (Amendment A1, CP-10). Not a Sign launch blocker. Revisit with the ATS erasure (S2) activation work. |
| Origin | CP-10 **Phase 5** of `documents/Aramo-Sign-Domain-Isolation-DB-Role-Rollout-Plan-20261028.md` ("the erase-talent CLI login"). CP-10 Phases 1–4 are done and verified in production. |
| Governing | `Aramo-Sign-Domain-Isolation-Reconciliation-V1-Directive-v1_0-LOCKED` (`e8d2fb1c…`) §2 R-2/R-4, §4 D-4; Amendment A1 (`a552ebfa…`) CP-10. S2 erasure activation is **separately unauthorized** and stays so. |
| Runbook | `doc/runbooks/talent-rtbf-erasure.md` |

## 1. Why this exists

A talent can ask an agency (the tenant) to delete their personal data (GDPR Art. 17 / CCPA). The
agency is the controller; Aramo is the processor and must help it do so. Today the deletion is
done by an Aramo operator with the backend `erase-talent` command:

```
node dist/apps/api/src/talent-anchor/erase-talent.command.js <TENANT_ID> <TALENT_ID>                      # dry run, no writes
node dist/apps/api/src/talent-anchor/erase-talent.command.js <TENANT_ID> <TALENT_ID> --execute <TALENT_ID> # live
node dist/apps/api/src/talent-anchor/erase-talent.command.js <TENANT_ID> <TALENT_ID> --resume <TALENT_ID>  # retry storage purge
```

The database already has the S2 safety gate: an erasure can only start through
`consent.s2_begin_talent_erasure_run(uuid, uuid, uuid, uuid[])` (SECURITY DEFINER, owned by
`aramo_erasure_definer`), which records who authorized which erasure and why. EXECUTE on it is
granted only to the NOLOGIN role `aramo_erasure_operator`, which has **no members** today.

## 2. The gap

There is no login an operator should use for the command:

| Login | Result |
|---|---|
| `aramo` (owner / superuser) | Works, but bypasses every grant: no recorded authorization, can reach Sign tables, can disable triggers. **Must not be used.** |
| `aramo_api` (the api runtime since CP-10 Phase 4) | Refused at the S2 entry point (not an erasure operator), by design: the web app can never start an erasure. |
| *(missing)* a dedicated erasure login | Needed: ATS data access plus the S2 entry point, nothing else. |

Separately, **who** may run it is not established. Production SSH proves only that a key is held:
everyone logs in as the shared `ubuntu` account with full sudo, and `auth.log` records the key
fingerprint, not a person. Today only the PO holds the designated key, so "who ran it" is the PO.

## 3. Proposed design (recommendations recorded during the run)

### 3.1 The erasure login (Phase 5 proper)

- Create `aramo_erasure_cli`, a member of exactly:
  - `aramo_ats_rw`: ATS data. **No USAGE on `sign`**, so signed contracts are out of reach; Sign data
    is erased only through Sign's own erasure contract (`apps/api/src/sign/sign-talent-erasure.client.ts`
    → `apps/sign-service/src/app/privacy/sign-talent-erasure.controller.ts`).
  - `aramo_erasure_operator`: the S2 entry point.
- NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS, owns nothing.
- **Recommended credential model: Option B (temporary password per run)**, instead of the rollout
  plan's permanent password in `/opt/aramo/.env`:
  - At rest the role is **NOLOGIN** and no password is stored anywhere.
  - A wrapper script (run with sudo over SSH) generates a random one-time password in memory, runs
    `ALTER ROLE aramo_erasure_cli LOGIN PASSWORD … VALID UNTIL now() + 2 hours`, runs the dry run
    and then the confirmed live run in a one-off container from the api image (credentials passed
    by environment, never argv), then sets **NOLOGIN** again in a `trap`, whatever the result.
  - The 2-hour `VALID UNTIL` closes the login even if the script dies.
  - The script requires the operator's name and the tenant's request reference and records them
    with the erasure run.
- Option A (rollout plan default): a permanent password in `/opt/aramo/.env` (root 0600). It is
  usable at any time by anyone with root, so it is weaker for a rarely used, high-impact path.

### 3.2 Who may run it (identity)

| Option | Identity | Effort | Assessment |
|---|---|---|---|
| **1. Platform-console "Erasure requests" screen (recommended long-term)** | Named admin.aramo.ai account with MFA (Cognito) and a dedicated role (e.g. `privacy_operator`); optional second-person approval; the backend runs the erasure with `aramo_erasure_cli` | New directive and build | Best: named person, MFA, full in-app audit, no server access for support |
| 2. Personal SSH accounts | One Linux user and key per person (no shared `ubuntu`); sudo limited to the erasure wrapper only; offboarding = delete the account | Small (box config) | Acceptable interim |
| 3. AWS SSM Session Manager | The person's own IAM identity; sessions recorded | Medium (Lightsail needs hybrid activation) | Good, more setup |
| Status quo | Key holder = PO | None | Only while the PO runs every erasure personally |

Never give support staff the shared `ubuntu` key.

## 4. Acceptance (when picked up)

1. Encrypted, restore-verified backup and a roles/grants snapshot before the change (CP-10 rule).
2. `aramo_erasure_cli` exists with exactly the two memberships; not a superuser; owns 0 objects.
3. Under Option B: cannot log in at rest; can log in only while the wrapper has it open; the login
   is disabled again after the run, including when the run fails.
4. As `aramo_erasure_cli`: SELECT on any `sign` table is denied; `has_function_privilege` on
   `consent.s2_begin_talent_erasure_run(...)` EXECUTE is true; DISABLE / DROP TRIGGER is refused;
   `SET session_replication_role` is refused.
5. A dry run against a test talent succeeds and writes nothing. A live run is **only** performed
   once S2 activation is separately authorized.
6. The runbook `doc/runbooks/talent-rtbf-erasure.md` is updated to name the login and the wrapper,
   and to forbid running as `aramo`.
7. Rollback: `DROP ROLE aramo_erasure_cli` (no objects owned; nothing else touched).

## 5. Related open items (from the same run)

- **Who runs erasures** (section 3.2) must be decided **before** S2 activation.
- The ATS's retained copy of Sign-executed documents is governed by the ATS `documents` module
  (legal hold / retention), and S2 erasure must honour `documents."DocumentArtifact".legal_hold`
  (Retention and Purge directive `ebd41d99…` R-2).
- Finding F-P4-1 (resolved in PR #1044): the Sign deletion path no longer reads ATS `documents`.
- Retention for legal-obligation records (employment contracts, payroll/tax, right-to-work) in the
  ATS needs a counsel-approved retention schedule before erasure goes live.
