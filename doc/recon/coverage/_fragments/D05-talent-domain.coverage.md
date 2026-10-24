| surface | inspected | not_verified | method/command |
| --- | --- | --- | --- |
| Lib @Controller files | 2 | 0 | `grep -rl '@Controller' libs/talent-record/src --include='*.ts' \| grep -v /tests/ \| wc -l` (none in the other 6 talent libs) |
| HTTP endpoints (2 controllers) | 31 | 0 | `grep -cE '^  @(Get\|Post\|Patch\|Put\|Delete\|Sse)\(' <each controller>` → 10 (intake) + 21 (record) |
| @Injectable source files (7 libs, excl tests) | 30 | 0 | `grep -rl '@Injectable' libs/talent-*/src --include='*.ts' \| grep -v /tests/ \| wc -l` (read key services in full; TalentExtractionService + full TalentTrustService read by signature only) |
| Prisma models (7 libs) | 35 | 0 | `grep -cE '^model ' libs/talent-*/prisma/schema.prisma` summed; key models opened and cited, remainder enumerated by header grep |
| Prisma enums (talent-evidence + embedding) | 16 | 0 | `grep -cE '^enum ' libs/talent-evidence/prisma/schema.prisma libs/talent-embedding/prisma/schema.prisma` |
| ADR anchors read | 4 | 0 | `0033`, `0018`, `ADR-0007 RTBF LOCKED`, `0027` read under `doc/adr/` |
| apps/api intake-consumer files | 1 of 8 | 7 | `ls apps/api/src/talent-intake-consumer/` = 8 files; only `talent-intake-consumer.module.ts` read in full (+config/handler/adapter grepped), not the publisher/drain/eventbridge bodies |
| FE talent files (ats-web) | 1 of 38 | 37 | `find apps/ats-web/src/talent -maxdepth 1 -name '*.tsx\|*.ts'` = 20 tsx + 18 ts; only `talent-intake-api.ts` wiring inspected (FE domains only) |
| BullMQ processors (talent-record + talent-reconcile) | 0 bodies | 4 | `grep -rln '@Processor' libs/talent-record/src libs/talent-reconcile/src` → resume-extraction-draft, resume-reindex, talent-reconcile, contradiction-detection processors; registration confirmed in `apps/api/src/app.module.ts:563` but processor bodies not read |
