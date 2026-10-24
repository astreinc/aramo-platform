# D11 — Search, Matching, Skills & Intelligence (COVERAGE)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212

| surface | inspected | not_verified | method/command |
|---|---|---|---|
| D11 libs on disk | 8 | 0 | `ls -d libs/{matching,skills-taxonomy,talent-embedding,conversation-intelligence,conversation-transcript,examination,reporting,metering}` |
| @Controller files in D11 libs | 4 | 0 | `grep -rl @Controller <D11 libs> --include='*.ts' \| grep -v /tests/ \| wc -l` → 4 (match-list, override, reporting, dashboard — all opened) |
| @Injectable files in D11 libs | 28 | 19 | `grep -rl @Injectable <D11 libs> \| grep -v /tests/ \| wc -l` → 28; 9 load-bearing services opened line-by-line, remaining 19 confirmed present by grep only |
| apps/api D11 controllers | 3 | 0 | opened examine.controller.ts, enterprise-search.controller.ts, skill-governance.controller.ts |
| Prisma model decls in D11 schemas | 18 | 0 (field-level: 3) | `grep -rhE '^model ' <D11 schemas> \| wc -l` → 18; examination schema read in full, other 5 schemas enumerated at decl line only (field-level detail not read for 15 models) |
| HTTP routes across D11 surface | 44 | 0 | reporting 16 + dashboard 1 + skill-governance 23 + examination 2 + examine 1 + enterprise-search 1; `grep -cE '@(Get\|Post\|Patch\|Delete)\('` per controller |
| BullMQ processors (D11 lib+apps) | 4 | 0 | `grep -rl '@Processor(' libs/matching libs/skills-taxonomy apps/api/src/embedding apps/api/src/conversation-intelligence \| grep -v /tests/ \| wc -l` → 4 (matching, skill-canonicalization, talent-embedding, ci) |
| Dark-gate env flags | 3 | 0 | `grep -rn 'EMBEDDING_PROCESSING_ENABLED\|CI_PROCESSING_ENABLED\|SKILL_CANONICAL_SHADOW_ENABLED' apps/api/src` — all three config files opened |
| apps/api composition wiring of D11 modules | 8 | 0 | `grep -n 'MatchingModule\|ReportingModule\|SkillsTaxonomyModule\|ExaminationModule\|TalentEmbeddingModule\|ConversationIntelligenceModule' apps/api/src/app.module.ts` + sub-module files |
| FE D11 surfaces (apps) | 5 | 5 (line-level) | `ls apps/ats-web/src \| grep -iE 'search\|report\|dashboard'` + `apps/platform-web/src/skills`; route wiring confirmed by grep of *-api.ts, component bodies not read line-by-line |
| D11 lib migration dirs | 22 | 22 (contents) | `ls libs/<lib>/prisma/migrations` → examination 7, skills-taxonomy 6, conversation-intelligence 3, conversation-transcript 3, metering 2, talent-embedding 1, reporting 0, matching 0; dir counts only, migration SQL not read |
| ADR / LOCKED anchors for D11 | 5 | 0 | ADR-0031, ADR-0029, ADR-0019 (rejected), ADR-0018, ADR-0015 opened/greped under `doc/adr/` |
