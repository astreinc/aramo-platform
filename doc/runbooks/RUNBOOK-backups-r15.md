# Runbook — Encrypted database backups (R-15) — SUPERSEDED

M-A8 §1 (`Aramo-Sign-Mobile-Amendment-M-A8-Account-Lifecycle-and-Permanent-Backups-v1_0-LOCKED.md`)
replaced M-A7 §2 / R-15. The procedure now lives in **[`RUNBOOK-backups.md`](RUNBOOK-backups.md)**:
key custody, principals, the `infrastructure-backups/` Terraform root (apply from the Mac), box
enablement, pre-deploy backups and encrypted `.env` snapshots, restore tests, deletion reconciliation,
legal hold and the historic-file disposition.

Nothing in this file is current. The R-15 Terraform (`infrastructure-lightsail/r15-backups.tf`) was
never applied and has been removed.
