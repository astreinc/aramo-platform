# D08 — Submittal, Engagement & Client Policy — Coverage
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212

| surface | inspected | not_verified | method/command |
|---|---|---|---|
| `@Controller` files in scope | 7 | 1 | `grep -rlE "@Controller\(" libs/submittal libs/client-talent-restriction apps/api/src/{create-submittal,submit-talent,submittal-workspace,engagement,client-submittal-policy} | grep -v test | wc -l` = 7. `submittal-workspace.controller.ts` was grep-located (route confirmed) but its handler bodies were not line-read. |
| HTTP handlers (`@Get`/`@Post`) | 26 | 1 | `grep -rhE "@(Get|Post)\(" <the 7 controller files> | wc -l` = 26. 25 routes enumerated in the AS-BUILT endpoint table; 1 residual handler (likely in the workspace controller) not individually traced. |
| `@Injectable` services / repositories | 17 | 6 | `grep -rlE "@Injectable\(" libs/submittal/src libs/submittal-eligibility/src libs/engagement/src libs/client-submittal-policy/src libs/client-talent-restriction/src apps/api/src/{create-submittal,submit-talent,submittal-workspace,engagement,client-submittal-policy} | grep -v test | wc -l` = 17. 11 read line-by-line; the per-module `PrismaService`s, the two policy gateway adapters, and the eligibility reader were not opened. |
| Prisma models (git-tracked) | 4 | 0 | `grep -hE "^model " libs/submittal/prisma/schema.prisma libs/client-talent-restriction/prisma/schema.prisma | wc -l` = 4 (`TalentSubmittalRecord`, `OutboxEvent`, `TalentSubmittalEvent`, `ClientTalentRestriction`). Engagement + Client-Submittal-Policy own no schema (persist via `@aramo/policy-store`). |
| Pure decision / domain functions | 11 | 0 | Read directly: `evaluateEligibility`, `deriveWindowStatus`, `consumeSlot`, `deriveSubmittalReadiness`, `evaluateSubmittalReadiness`, `pipelineLinkVerdict`, `isRequisitionSubmittable`, `canTransition`, `decideEngagement`, `EngagementPolicyService.mergeLayers`, `ClientSubmittalPolicyService.mergeLayers`. |
| OpenAPI `ats.yaml` domain paths | 14 | 0 | `grep -cE "^  /v1/(submittals\|engagement)" openapi/ats.yaml` = 14. `/v1/client-submittal-policy/*` and `.../restrictions` paths are ABSENT (confirmed by grep → gap D08-G1). |
| Pact contract files (D08) | 2 | 2 | `ls pact/consumers/*/src/ | grep -iE "submittal\|engagement\|restriction\|client-submittal" | wc -l` = 2. Files located, not opened. |
| ADR anchors | 4 | 2 | ADR-0024 read in full (`doc/adr/0024-business-policy-engine.md`). ADR-0027 / 0029 / 0030 referenced by title + LOCKED status; their sections were not line-read. |

Notes:
- The AS-BUILT doc carries 154 `path:line` citations (`grep -oE "[A-Za-z0-9_./-]+\.(ts|tsx|prisma|yaml):[0-9]+" <as-built> | wc -l`) and 3 mermaid diagrams.
- `libs/submittal`, `libs/client-talent-restriction`, and `libs/submittal-eligibility` carry committed `prisma/generated/client/` output (scoping-excluded from the model count above, which reads the authored `prisma/schema.prisma` only).
