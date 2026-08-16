# T8 Connector Program — Connector-A Closure / Connector-B Deferment

Status: ACTIVE CARRY-FORWARD RECORD
Recorded: 2026-08-15

## 1. T8-CONNECTOR-A Closure

T8-CONNECTOR-A is MERGED / CLOSED — NOT DEPLOYED.

PR:
#628

Reviewed Gate-6 head:
71a43f2303ebc09c908880fbfe10882a575be8a0

Exact-head CI:
31864948462 — GREEN

Merge commit:
3aba5ff38bc8997a1ad31774fb2978dbd826fd41

Merged at:
2026-08-15T12:05:29Z

Merge topology:
- parent 1: 5f8391df211c87357ceea69b21bcf8bf4cae9fc0
- parent 2: 71a43f2303ebc09c908880fbfe10882a575be8a0
- two-parent non-fast-forward
- no squash
- no rebase

Canonical authority:
Aramo-T8-CONNECTOR-A-Directive-v1_0-LOCKED.md

Directive SHA-256:
d16ce0a1d26217d78be34dee5beeef3d2b62539ec17fe9d923807d6efc371b5a

## 2. Deployment Status

T8-CONNECTOR-A has NOT been deployed.

The merge did not authorize or perform:

- deployment
- production migration
- production query
- production secret creation
- provider selection
- external provider calls

MERGED does not imply DEPLOYED.

## 3. T8-CONNECTOR-B Status

T8-CONNECTOR-B is:

DEFERRED / NOT STARTED / NOT AUTHORIZED

No Connector-B implementation authority was created by the
T8-CONNECTOR-A merge.

Specifically NOT authorized:

- Build-Start
- implementation
- commit
- push
- PR
- merge
- deployment
- provider-specific transport implementation
- first-provider selection
- requisition update/upsert

## 4. Required Re-Activation Sequence

When T8-CONNECTOR-B is resumed, begin with a fresh governance cycle.

Required sequence:

1. Current-state reconciliation against then-current origin/main.
2. Verify T8-CONNECTOR-A merged substrate remains intact.
3. Recover the governing T8 program authority and current ledger state.
4. Determine Connector-B scope from authoritative artifacts; do not
   infer it from Connector-A implementation.
5. Reconcile any intervening changes to:
   - IntegrationConnection
   - ConnectorDelivery
   - integration RBAC
   - secret handling
   - BullMQ execution
   - P2 requisition import
   - provider adapter boundary
   - T8-P3 monitoring
6. Architect rulings on any unresolved Connector-B semantics.
7. Materialize/file a LOCKED Connector-B directive if required.
8. Separate Build-Start authorization.
9. Gate-5 implementation only after Build-Start acceptance.

## 5. Important Forward Locks

T8-CONNECTOR-B must not silently assume:

- a first VMS/provider
- polling cadence
- webhook transport
- SFTP transport
- OAuth transport
- provider credentials
- update/upsert behavior
- requisition mutation beyond the canonical T8-P2 CREATE-only contract

Any such behavior requires explicit authority during the Connector-B
activation cycle.

## 6. Carry-Forward Baseline

At the time this record was created:

T8-CONNECTOR-A:
MERGED / CLOSED

T8-CONNECTOR-A merge:
3aba5ff38bc8997a1ad31774fb2978dbd826fd41

T8-CONNECTOR-B:
DEFERRED / NOT STARTED

Deployment:
NOT PERFORMED

First provider:
NOT SELECTED

Requisition update/upsert:
NOT AUTHORIZED
