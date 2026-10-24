# D02 — Database & Domain Data Model (COVERAGE)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212

| surface | inspected | not_verified | method/command |
|---|---|---|---|
| Tracked `schema.prisma` files | 53 | 0 | `git ls-files '*/prisma/schema.prisma' \| wc -l` |
| Schema files opened + read in full for this audit | 12 | 41 | manual Read of talent-record, pipeline, requisition, placement, submittal, client-selection, identity, identity-index, documents, esign, communications, company; remaining 41 inspected by model-name grep + datasource/namespace grep |
| `model` declarations (tracked) | 209 | 0 | `git ls-files '*/prisma/schema.prisma' \| xargs grep -hE '^model ' \| wc -l` |
| Model names enumerated per schema | 209 | 0 | `for f in $(git ls-files '*/prisma/schema.prisma'); do grep -E '^model ' "$f"; done` |
| Scaffold-only (zero-model) schemas | 5 | 0 | per-file `grep -cE '^model '` = 0 for audit, auth, common, events, matching |
| Distinct `@@schema` namespaces | 50 | 0 | `git ls-files '*/prisma/schema.prisma' \| xargs grep -hoE '@@schema\("[^"]+"\)' \| sort -u \| wc -l` |
| Total `@@schema` annotation lines | 307 | 0 | `git ls-files '*/prisma/schema.prisma' \| xargs grep -hE '@@schema' \| wc -l` |
| Multi-namespace datasource arrays | 3 | 0 | per-file parse of `schemas =` line → canonicalization, consent, placement |
| `enum` declarations (tracked) | 97 | 0 | `git ls-files '*/prisma/schema.prisma' \| xargs grep -hcE '^enum ' \| paste -sd+ \| bc` |
| Tracked `migration.sql` files | 253 | 0 | `git ls-files '*/prisma/migrations/*/migration.sql' \| wc -l` |
| Migrations with a BEFORE UPDATE/INSERT reject trigger | 53 | 200 | `git ls-files '*/prisma/migrations/*/migration.sql' \| xargs grep -lE 'BEFORE UPDATE\|BEFORE INSERT OR UPDATE\|reject.*update' \| wc -l` (count only; per-trigger classification NOT done) |
| Schema files declaring `Unsupported(...)` columns | 4 | 0 | `git ls-files '*/prisma/schema.prisma' \| xargs grep -lE 'Unsupported\('` → company, requisition, talent-embedding, talent-record |
| `OutboxEvent`-style model tables | 11 | 0 | `grep -nE 'model (OutboxEvent\|OfferOutboxEvent\|TalentIntakeOutboxEvent)'` across tracked schemas |
| Outbox-publisher drained schema repositories | 7 | 4 | injected repos in `libs/outbox-publisher/src/lib/outbox-publisher.processor.ts` (7); offer/documents/esign/talent-evidence outbox drain status partially verified (see D02-G1) |
| ADR/convention AS-DESIGNED anchors located | 10 | — | manual read of `doc/05-conventions.md` DB section + `doc/adr/*` (0016, 0029, 0033, 0032, 0019, 0007) |
| Endpoint↔table mapping | 0 | all | out of D02 scope (owned by per-domain API recon) |
| FE↔table wiring | 0 | all | out of D02 scope (owned by per-feature FE recon) |
| Live-DB applied-migration / FK-absence confirmation | 0 | all | static schema audit only; no live `information_schema` inspected |
