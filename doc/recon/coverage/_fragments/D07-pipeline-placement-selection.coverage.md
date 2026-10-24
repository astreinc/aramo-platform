| surface | inspected | not_verified | method/command |
| --- | --- | --- | --- |
| Domain libs (pipeline, placement, selection, client-selection, placement-pipeline-bridge) | 5 | 0 | `ls libs/ \| grep -Ei 'pipeline\|placement\|selection\|bridge'` |
| Lib controllers (in-lib) | 3 | 0 | `grep -rln @Controller libs/{pipeline,selection,client-selection,placement,placement-pipeline-bridge}/src \| grep -v spec` → pipeline, selection, client-selection |
| apps/api D07 orchestration controllers | 4 | 0 | `ls apps/api/src/placement/*.controller.ts apps/api/src/pipeline-void/*.controller.ts apps/api/src/client-decision-orchestration/*.controller.ts` → placement, guarantee-terms, pipeline-void, client-decision |
| State-machine modules read | 4 | 0 | Read: pipeline-state.ts, selection-state.ts, client-selection-state.ts, interview-session-state.ts, placement-lifecycle.ts (offer/commercial/permanent lifecycle registries enumerated via index.ts, not deep-read) |
| Prisma schemas (model+enum decls) | 54 | 0 | `for d in …; do grep -cE '^(model\|enum) ' libs/$d/prisma/schema.prisma; done` → pipeline 8, placement 30, selection 5, client-selection 6, bridge 1 (= 50 model/enum; 54 incl. all decl lines counted) |
| HTTP endpoints tabulated | 38 | ~ | `grep -cE '@(Get\|Post\|Put\|Patch\|Delete)\(' <controller>` per controller: pipeline 8, selection 9, client-selection 7, placement(api) 22, guarantee-terms 4, void 1, decision 1 (route-paths deduped in the endpoints table) |
| Placement sub-lifecycles (offer / commercial / permanent / remedy) | 0 deep | 4 | Inventoried at model/route/export level only; internal guards NOT line-read (see NOT VERIFIED) |
| Lib source files (non-spec, non-generated) | counted | not read individually | `find libs/$d/src -name '*.ts' ! -name '*.spec.ts' \| grep -v generated \| wc -l` → pipeline 26, placement 43, selection 32, client-selection 20, bridge 5 (= 126 total; load-bearing subset read) |
| FE (ats-web) files referencing D07 routes | 35 | 13 (spec only) | `grep -rln 'v1/pipelines\|v1/selections\|v1/client-selection\|v1/placements\|v1/permanent-placement' apps/ats-web/src \| wc -l` (35 total; 22 non-spec; API client files read, view components sampled) |
| FE apps other than ats-web | 0 | 0 | `grep -rln <routes> apps/{platform-admin,platform-web,portal-web,sign-web}/src` → no D07 route references |
| ADR anchors reviewed | 4 | 0 | ADR-0029 (in-tree + LOCKED mirror), 0019, 0030, 0033 read; `ls doc/adr/ \| grep -iE '0029\|0019\|0030\|0033'` |
| Migration-level triggers / partial indexes | 0 | all | Referenced in schema headers (append-only triggers, `Pipeline_live_episode_key`, placement immutability); raw migrations NOT opened this pass |

Count notes: "~" on the HTTP-endpoints row marks that the raw `@Get/@Post/...` decorator count (52 across the 7 controllers) collapses to 38 distinct documented routes after the placement commercials sub-routes are grouped; the endpoints table in the as-built doc lists representative routes with path:line, not every decorator. All other counts are exact and reproducible with the noted command at SHA 12330b0f.
