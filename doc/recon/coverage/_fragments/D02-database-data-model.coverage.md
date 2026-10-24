# D02 — Database & Domain Data Model (COVERAGE)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124

Commands run against `680907fc` (counts were derived over `git ls-tree -r --name-only 680907fc` paths, read through a `git archive 680907fc` export; old-baseline figures in parentheses).

| surface | inspected | not_verified | method/command |
|---|---|---|---|
| Tracked `schema.prisma` files | 54 (53) | 0 | `git ls-tree -r --name-only 680907fc \| grep -E '/prisma/schema\.prisma$' \| wc -l` |
| Schema files added / removed since 12330b0f | 5 added, 4 removed | 0 | `git diff --name-status -M 12330b0f 680907fc -- '*/prisma/schema.prisma'` → A intelligence-core, sign, signature-routing, subscription, technical-screening; D esign, identity-index, platform-trust, talent-trust |
| Schema files opened + read (in full or new/changed sections) for this audit | 17 | 37 | read talent-record, talent-evidence (new sections), identity, intelligence-core, sign, subscription (header + models), signature-routing (header), technical-screening, consent, documents (model headers), communications (model headers), pipeline, requisition, placement, submittal, client-selection, company; remaining 37 inspected by model-name grep + datasource/namespace grep |
| `model` declarations (tracked) | 283 (209) | 0 | `for f in <tracked schemas>; do git show 680907fc:$f \| grep -E '^model '; done \| wc -l` |
| Model names enumerated per schema | 283 | 0 | per-file `grep -E '^model '` |
| Scaffold-only (zero-model) schemas | 5 (5) | 0 | per-file `grep -cE '^model '` = 0 for audit, auth, common, events, matching |
| Distinct `@@schema` namespaces | 51 (50) | 0 | per-file `grep -oE '@@schema\("[^"]+"\)' \| sort -u \| wc -l` (added intelligence, sign, signature_routing, subscription, technical_screening; removed esign, identity_index, platform_trust, talent_trust) |
| Total `@@schema` annotation lines | 382 (307) | 0 | per-file `grep -E '@@schema' \| wc -l` |
| Multi-namespace datasource arrays | 4 (3) | 0 | per-file parse of `schemas =` line → canonicalization, communications, consent, placement |
| `enum` declarations (tracked) | 98 (97) | 0 | per-file `grep -E '^enum ' \| wc -l` summed |
| Tracked `migration.sql` files | 314 (253) | 0 | `git ls-tree -r --name-only 680907fc \| grep -E '/prisma/migrations/.*/migration\.sql$' \| wc -l` |
| Migration files changed since 12330b0f | 84 A, 23 D, 5 R | 0 | `git diff --name-status -M 12330b0f 680907fc -- 'libs/*/prisma/migrations/*/migration.sql' \| cut -c1 \| sort \| uniq -c` |
| Migrations per lib that changed (old → new) | 24 libs | 0 | per-lib `ls libs/<lib>/prisma/migrations/*/migration.sql \| wc -l` at both SHAs: activity 3→5, auth-storage 2→3, client-selection 5→6, client-talent-restriction 1→2, communications 8→14, consent 2→5, conversation-intelligence 2→3, documents 6→17, entitlement 2→4, identity 12→31, ingestion 11→12, intelligence-core 0→4, pipeline 14→15, requisition 22→23, sign 0→14 (esign 5→0, renamed), signature-routing 0→2, skills-taxonomy 6→7, subscription 0→8, talent-evidence 13→17, talent-record 17→21, technical-screening 0→2, identity-index 1→0, platform-trust 1→0, talent-trust 21→0 |
| Migrations applying to the separate TI database | 4 | 0 | `libs/intelligence-core/prisma/migrations/*` (excluded by `tools/db-sync-local.sh:53`) |
| Migrations with a BEFORE UPDATE/INSERT reject trigger | 67 (53) | 247 | `grep -lE 'BEFORE UPDATE\|BEFORE INSERT OR UPDATE\|reject.*update'` over the 314 files (count only; per-trigger classification NOT done) |
| Migrations with a BEFORE UPDATE / BEFORE INSERT OR UPDATE trigger (as-built figure) | 56 (45) | 258 | `grep -lE 'BEFORE UPDATE\|BEFORE INSERT OR UPDATE'` over the 314 files |
| S2 erasure migrations | 9 | 0 | `ls -d libs/*/prisma/migrations/*_s2_*` → activity (2), client-selection (1), client-talent-restriction (1), consent (3), documents (1), pipeline (1) (header of `20261016190000_s2_erasure_write_serialization` read; holder-coverage proof NOT run) |
| Schema files declaring `Unsupported(...)` columns | 4 (4) | 0 | per-file `grep -l 'Unsupported('` → company, requisition, talent-embedding, talent-record |
| `OutboxEvent`-style model tables | 13 (11) | 0 | `grep -nE '^model (OutboxEvent\|OfferOutboxEvent\|TalentIntakeOutboxEvent\|TalentEventOutbox\|IntelligenceOutbox)\b'` across tracked schemas |
| Outbox-publisher drained schema repositories | 7 (7) | 2 | injected repos in `libs/outbox-publisher/src/lib/outbox-publisher.processor.ts` (7); 4 self-drains located by grep (talent-evidence, talent-record, intelligence-core, sign); documents + offer have no reader found (see D02-G1) |
| ADR/convention/directive AS-DESIGNED anchors located | 18 (10) | — | manual read of `doc/05-conventions.md` DB section + `doc/adr/*` (0016, 0029, 0033, 0032, 0019, 0007, 0036) + LOCKED directives (ATI-SEP-1 + A1–A4, Sign Naming, S2 amendment, Multi-Provider Plan Entitlements, Commercial Plans A1, Personal Free v1.1 + A1, Domain-Enforcement P3, Sign Signup A1, ROLES-1 / ADR-0035, TIP-E2E INC-3 + A1, ADR-0034 / DOC-TEMPLATE-LIB-1) + `doc/directives/Aramo-COMM-C2B-Amendment-A1-Outlook-Scheduling-v1_0-LOCKED.md` |
| Endpoint↔table mapping | 0 | all | out of D02 scope (owned by per-domain API recon) |
| FE↔table wiring | 0 | all | out of D02 scope (owned by per-feature FE recon) |
| Live-DB applied-migration / FK-absence confirmation | 0 | all | static schema audit only; no live `information_schema` inspected; drop-migration and TI-database application status NOT verified |
