# D06 — Requisition, Job & VMS (COVERAGE)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212

| surface | inspected | not_verified | method/command |
| --- | --- | --- | --- |
| D06 core libs (requisition, job-domain, job-distribution, pre-start-requirement) | 4 | 0 | `ls libs/{requisition,job-domain,job-distribution,pre-start-requirement}` |
| D06 HTTP controllers (requisition, mapping-admin, pre-start) | 3 | 0 | `grep -rln '@Controller' libs/requisition libs/job-domain libs/job-distribution libs/pre-start-requirement libs/integration/src/lib/lifecycle apps/api/src/requisition-integration apps/api/src/pre-start-requirement` |
| RequisitionController endpoints | 13 | 0 | `grep -cE "@(Get\|Post\|Put\|Patch\|Delete)\(" libs/requisition/src/lib/requisition.controller.ts` |
| VMS mapping-admin endpoints | 7 | 0 | `grep -cE "@(Get\|Post\|Put\|Patch\|Delete)\(" libs/integration/src/lib/lifecycle/mapping-admin/requisition-lifecycle-mapping-admin.controller.ts` |
| Pre-start-requirement endpoints | 13 | 0 | `grep -cE "@(Get\|Post\|Put\|Patch\|Delete)\(" apps/api/src/pre-start-requirement/pre-start-requirement.controller.ts` |
| `requisition` schema models | 7 | 0 | `grep -cE "^model " libs/requisition/prisma/schema.prisma` |
| `requisition` schema enums | 5 | 0 | `grep -cE "^enum " libs/requisition/prisma/schema.prisma` |
| RecruitingStatus values | 9 | 0 | `awk '/^enum RecruitingStatus/{f=1}...' libs/requisition/prisma/schema.prisma` |
| Governed TRANSITION_ACTIONS | 8 | 0 | `grep -cE "^  '[A-Z_]+'," libs/requisition/src/lib/dto/requisition-transitions.ts` |
| `requisition` migrations | 23 | 0 | `ls libs/requisition/prisma/migrations \| wc -l` |
| integration lifecycle/mapping/reconciliation models | 10 | 0 | `grep -nE '^model \|^enum ' libs/integration/prisma/schema.prisma \| grep -iE 'lifecycle\|mapping\|reconcil\|provenance\|observation\|identity'` |
| requisition.repository.ts (write/read floor, 2406 lines) | 1 | 0 | `Read` full file (1-1180, 1181-1880); tail 1880-2406 not line-read |
| ats-web requisition FE files | 56 | 0 | `find apps/ats-web/src -type f \| grep -iE 'requisition\|job\|vms\|lifecycle-mapping'` (count via wc) |
| requisition FE→BE api client wiring | 1 (requisitions-api.ts) | 0 | Read apps/ats-web/src/requisitions/requisitions-api.ts |
| OpenAPI documented requisition operations (ats.yaml) | 1 (POST only) | 0 | `grep -nE '/v1/requisitions:' openapi/ats.yaml` + awk method scan |
| ReconciliationDrainService.drainBatch internals | 0 | 1 | not line-read (processor header only) |
| LifecyclePollProducer schedule | 0 | 1 | not read |
| ActivityNote (libs/activity) requisition linkage | partial | 1 | `grep -nE 'model \|requisition' libs/activity/prisma/schema.prisma` (cross-domain; full audit deferred) |
| Scope seeding (catalog/id-map) for requisition scopes | 0 | 1 | not cross-checked against seed layer |
| Runtime/test execution | 0 | 1 | static read only; no tests run at frozen SHA |
