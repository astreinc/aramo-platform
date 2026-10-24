# D06 — Requisition, Job & VMS (COVERAGE)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124

All commands re-run against the frozen tree with `git grep … 680907fc` /
`git show 680907fc:<path>` / `git ls-tree 680907fc` (no working-tree reads).

| surface | inspected | not_verified | method/command |
| --- | --- | --- | --- |
| D06 core libs (requisition, job-domain, job-distribution, pre-start-requirement) | 4 | 0 | `git ls-tree -d --name-only 680907fc libs/ \| grep -E 'libs/(requisition\|job-domain\|job-distribution\|pre-start-requirement)$'` |
| D06 HTTP controllers (requisition, mapping-admin, pre-start) | 3 | 0 | `git grep -l '@Controller' 680907fc -- libs/requisition libs/job-domain libs/job-distribution libs/pre-start-requirement libs/integration/src/lib/lifecycle apps/api/src/requisition-integration apps/api/src/pre-start-requirement \| wc -l` |
| RequisitionController endpoints | 13 | 0 | `git show 680907fc:libs/requisition/src/lib/requisition.controller.ts \| grep -cE "@(Get\|Post\|Put\|Patch\|Delete)\("` (unchanged count; `GET` list gained the opt-in `paged` mode) |
| VMS mapping-admin endpoints | 7 | 0 | `git show 680907fc:libs/integration/src/lib/lifecycle/mapping-admin/requisition-lifecycle-mapping-admin.controller.ts \| grep -cE "@(Get\|Post\|Put\|Patch\|Delete)\("` |
| Pre-start-requirement endpoints | 13 | 0 | `git show 680907fc:apps/api/src/pre-start-requirement/pre-start-requirement.controller.ts \| grep -cE "@(Get\|Post\|Put\|Patch\|Delete)\("` |
| `requisition` schema models | 7 | 0 | `git show 680907fc:libs/requisition/prisma/schema.prisma \| grep -cE "^model "` |
| `requisition` schema enums | 5 | 0 | `git show 680907fc:libs/requisition/prisma/schema.prisma \| grep -cE "^enum "` |
| `RequisitionLifecycleEvent` hold columns (new) | 4 | 0 | `git show 680907fc:libs/requisition/prisma/schema.prisma \| grep -cE "^  hold_"` |
| RecruitingStatus values | 9 | 0 | `git show 680907fc:libs/requisition/prisma/schema.prisma \| awk '/^enum RecruitingStatus/{f=1;next} f&&/^}/{f=0} f&&/^  [a-z_]+$/' \| wc -l` |
| Governed TRANSITION_ACTIONS | 8 | 0 | `git show 680907fc:libs/requisition/src/lib/dto/requisition-transitions.ts \| grep -cE "^  '[A-Z_]+',"` |
| `requisition` migrations | 24 | 0 | `git ls-tree --name-only 680907fc libs/requisition/prisma/migrations/ \| wc -l` (old baseline 23; +`20261021090000_s3_requisition_hold_details`) |
| integration lifecycle/mapping/reconciliation models + enums | 12 | 0 | `git show 680907fc:libs/integration/prisma/schema.prisma \| grep -nE '^model \|^enum ' \| grep -ciE 'lifecycle\|mapping\|reconcil\|provenance\|observation\|identity'` (the old fragment recorded 10; the same command returns 12 at 12330b0f too, so the count is unchanged and the old figure was a transcription slip) |
| requisition.repository.ts (write/read floor, 2752 lines) | 1 | 0 | `git show 680907fc:libs/requisition/src/lib/requisition.repository.ts \| wc -l` = 2752; diff 12330b0f..680907fc read in full (every changed hunk); unchanged regions re-anchored by symbol grep |
| Lifecycle policy package (v8.0.0) | 1 | 0 | `git show 680907fc:apps/api/src/policy/requisition-lifecycle.package.ts \| grep -n "version: '"` |
| apps/api D06 consumers added (TI read-seam adapter, contact-send gate) | 2 | 0 | `git ls-tree --name-only 680907fc apps/api/src/talent-intelligence/requisition-context-read.adapter.ts apps/api/src/requisition-lifecycle/requisition-contact.gate.ts` |
| ats-web requisition FE files | 98 | 0 | `git ls-tree -r --name-only 680907fc apps/ats-web/src \| grep -iE 'requisition\|job\|vms\|lifecycle-mapping' \| wc -l` (old fragment recorded 56 from a working-tree `find`; the same `ls-tree` command returns 81 at 12330b0f) |
| requisition FE→BE api client wiring | 1 (requisitions-api.ts) | 0 | `git show 680907fc:apps/ats-web/src/requisitions/requisitions-api.ts \| grep -nE "export (async )?function\|v1/"` |
| OpenAPI documented requisition operations (ats.yaml) | 2 (GET + POST) | 0 | `git show 680907fc:openapi/ats.yaml \| awk '/^  \/v1\/requisitions:/{f=1;next} f&&/^  \//{f=0} f&&/^    (get\|post\|put\|patch\|delete):/'` (old baseline 1, POST only) |
| ReconciliationDrainService.drainBatch internals | 0 | 1 | not line-read (processor header only; file unchanged since 12330b0f) |
| LifecyclePollProducer schedule | 0 | 1 | not read |
| ActivityNote (libs/activity) requisition linkage | partial | 1 | `git show 680907fc:libs/activity/prisma/schema.prisma \| grep -nE 'model \|requisition'` (cross-domain; full audit deferred) |
| Scope seeding (catalog/id-map) for requisition scopes | 0 | 1 | not cross-checked against seed layer |
| Talent × Requisition 360 FE (`talent-requisition-360/`, 10 files incl. specs and css) | 0 | 1 | `git ls-tree -r --name-only 680907fc apps/ats-web/src/requisitions/talent-requisition-360 \| wc -l`; file list only |
| Runtime/test execution | 0 | 1 | static read only; no tests run at frozen SHA |
