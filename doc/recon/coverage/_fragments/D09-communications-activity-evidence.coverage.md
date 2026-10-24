# D09 — Communications, Activity & Recruiting Evidence (COVERAGE)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212

"inspected" = file opened and the cited symbol confirmed on the line. "not_verified"
= enumerated by command but not individually opened in this pass.

| surface | inspected | not_verified | method/command |
|---------|-----------|--------------|----------------|
| D09 domain libs (communications, activity, contact, calendar) | 4 | 0 | `ls libs/ \| grep -Ei 'communic\|activity\|contact\|calendar'` — all four read (schema + key src) |
| Prisma models across the 4 libs | 11 | 0 | `for d in communications activity contact calendar; do grep -c '^model ' libs/$d/prisma/schema.prisma; done` = 6+3+1+1=11; each `model` decl confirmed, field-level detail read for CommunicationInteraction/ActivityNote/ActivityNoteEvent |
| @Controller files in-scope (libs + apps/api comms + talent-journey) | 11 | 0 | `grep -rl '@Controller' libs/{communications,activity,contact,calendar} apps/api/src/{communications,talent-journey} --include='*.ts' \| grep -v generated \| wc -l` = 11; routes read per controller |
| Prisma migrations across the 4 libs | 1 | 16 | `for d in …; do ls libs/$d/prisma/migrations \| grep -c '^2'; done` = 8+3+5+1=17; only `20261006160000_recruiting_journey_attested_response_evidence` read in full |
| libs/communications src (non-generated, non-test) | 7 | 12 | `find libs/communications/src -name '*.ts' \| grep -v generated \| grep -v /tests/ \| wc -l` = 19; read: repository, communications-enums, module, email-template renderer refs, prisma, provider ports (partial) |
| libs/communications test specs | 0 | 10 | `find libs/communications/src/tests -name '*.spec.ts' \| wc -l` = 10; listed only |
| libs/activity src (non-generated, non-test) | 5 | 11 | `find libs/activity/src -name '*.ts' \| grep -v generated \| grep -v /tests/ \| wc -l` = 16; read: schema, repository (ledger writes), controller routes, insert-activity (header) |
| libs/contact + libs/calendar src | 2 | 19 | contact=11, calendar=10 non-gen non-test src; read: contact.controller + calendar.controller routes + both schemas |
| apps/api/src/communications ts (non-test) | 12 | 21 | `find apps/api/src/communications -name '*.ts' \| grep -v '\.spec\.' \| wc -l` = 33; read: 7 controllers (routes), talent-response.service, talent-response.controller, zoom-webhook.service, draft controllers |
| apps/api/src/talent-journey ts (non-test) | 2 | 2 | `find apps/api/src/talent-journey -name '*.ts' \| grep -v '\.spec\.' \| wc -l` = 4; read: talent-journey-read.service (full), talent-journey.controller (routes) |
| apps/api microsoft email orchestration | 1 | 0 | `apps/api/src/microsoft/microsoft-email.service.ts` — `maybeAdvanceToContacted` + recordContactEvidence call read |
| pipeline evidence core (pipeline-state + pipeline.repository) | 2 | 0 | `libs/pipeline/src/lib/pipeline-state.ts` + `pipeline.repository.ts` evidence gate / recordContactEvidence / recordResponseEvidence / reconcileForward read |
| common error registration (PIPELINE_STAGE_REQUIRES_EVIDENCE) | 2 | 0 | `grep -n PIPELINE_STAGE_REQUIRES_EVIDENCE libs/common/src/lib/errors/{error-codes.ts,aramo-error.ts}` — code + 422 mapping confirmed |
| ats-web src/communications files | 2 | 21 | `ls apps/ats-web/src/communications \| wc -l` = 23; read: talent-response-api.ts, RecordTalentResponseModal.tsx (422 handler) |
| ats-web journey wiring (requisitions + pipeline) | 2 | 0 | `TalentJourneySection.tsx` (recruiting_available_actions consumption) + `talent-journey-api.ts` read |
| AS-DESIGNED anchors (doc/adr + OneDrive LOCKED) | — | — | `ls doc/adr/`; `grep -rliE 'recruiting.journey\|evidence' doc/adr`; OneDrive `Aramo/locked` listing — ADR-0029/0031 + L2-H/L2-C/COMM/RN-1 directives located; evidence-milestone directive NOT located |
