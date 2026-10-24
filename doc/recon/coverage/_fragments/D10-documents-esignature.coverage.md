# D10 — Documents & E-Signature (COVERAGE)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124

All commands run against the frozen tree (`git show 680907fc:<path>`, `git grep … 680907fc`, `git ls-tree … 680907fc`).

| surface | inspected | not_verified | method/command |
|---|---|---|---|
| Core Documents OpenAPI endpoints | 35 | 0 | `git show 680907fc:openapi/documents.yaml \| grep -cE '^  /v1/'` = 35 paths; `grep -cE '^    (get\|post\|put\|patch\|delete):'` = 48 operations, equal to the 43 `libs/documents` controller ops + 5 `apps/api` Documents↔Sign seam ops (paths enumerated; not each cross-checked field by field) |
| Sign OpenAPI endpoints (`openapi/sign.yaml`, renamed from `esign.yaml`) | 71 | 4 | `git show 680907fc:openapi/sign.yaml \| grep -cE '^  /v1/'` = 71 paths, 75 operations; cross-checked vs 79 sign-service controller ops → 4 signer ops undocumented (G1) |
| Core Documents controller HTTP methods | 43 | 0 | `git grep -cE '@(Get\|Post\|Put\|Patch\|Delete)\(' 680907fc -- libs/documents/src/lib/` = 9 (`documents.controller.ts`) + 29 (`templates.controller.ts`) + 5 (`template-library.controller.ts`); route decorators + scopes enumerated |
| Sign service controller HTTP methods | 79 | 0 | same grep over `apps/sign-service/src/app` = 79 across 10 controller files (esign-http 17, sender 22, sender-templates 3, integration-admin 12, sign-api 10, billing 5, inbox 5, legal 2, account 2, report 1); decorators + guards enumerated; `esign-http.controller.ts` read in its route/guard sections |
| `apps/api` D10 controllers | 10 | 0 | `git ls-tree -r --name-only 680907fc -- apps/api/src/{documents,integrations/sign,rtr,offer-document,document-signing,document-templates-platform,esignature-providers} \| grep -c 'controller.ts$'` = 10 (41 HTTP methods); `esign-events.controller.ts` and `documents-esign.controller.ts` read in full, others by decorator grep |
| `apps/platform-admin` Sign signup controllers | 2 | 0 | `git grep -nE "@Controller\('[^']*signup" 680907fc -- apps` = 2 (12 routes); decorators + dark-gate lines only |
| `documents` schema models | 17 | 0 | `git show 680907fc:libs/documents/prisma/schema.prisma \| grep -c '^model '` = 17 (template models read via diff from 12330b0f) |
| `sign` schema models | 22 | 0 | `git show 680907fc:libs/sign/prisma/schema.prisma \| grep -c '^model '` = 22 (schema read in full) |
| `subscription` schema models | 14 | 0 | `git show 680907fc:libs/subscription/prisma/schema.prisma \| grep -c '^model '` = 14 (schema read in full) |
| `signature_routing` schema models | 4 | 0 | `git show 680907fc:libs/signature-routing/prisma/schema.prisma \| grep -c '^model '` = 4 (schema read in full) |
| `documents` migration SQL files | 1 | 16 | `git ls-tree --name-only 680907fc libs/documents/prisma/migrations/ \| sed 's#.*/##' \| grep -c '^[0-9]'` = 17; header of `20261016180200_s2_document_event_erasure_delete` read; others inferred from schema comments |
| `sign` migration SQL files | 1 | 13 | same command on `libs/sign/prisma/migrations/` = 14; header of `20261020130400_sign_naming_schema` read |
| `subscription` migration SQL files | 1 | 7 | same command on `libs/subscription/prisma/migrations/` = 8; `20261023100000_sign_personal_free` DAY-window insert read |
| `signature_routing` migration SQL files | 0 | 2 | same command on `libs/signature-routing/prisma/migrations/` = 2; not read |
| `libs/documents` lib src files | 4 | 14 | `git ls-tree -r --name-only 680907fc -- libs/documents/src/lib \| grep -E '\.tsx?$' \| grep -vE '\.(spec\|test)\.' \| wc -l` = 18; read the 3 controllers (decorators) + template-resolution header; repositories/render/idempotency/requirements/revision-source/write-back/storage/ports by symbol grep only |
| `libs/sign` lib src files | 3 | 28 | same command on `libs/sign/src/lib` = 31; read envelope-lifecycle, schema-adjacent esign.service method index, outbox.service; others by symbol grep |
| `apps/sign-service` app src files | 6 | 44 | same command on `apps/sign-service/src/app` = 50; read app.module, esign-http.controller (routes/guards), delivery worker, allowance gate header, personal send gate header, events/s2s adapters by grep; services bodies NOT VERIFIED |
| `libs/subscription` lib src files | 3 | 13 | same command on `libs/subscription/src/lib` = 16; headers of legal-documents, free-personal-subscription, subscription-lifecycle; feature-availability tail |
| `libs/signature-routing` lib src files | 1 | 2 | same command = 3; repository class located |
| `apps/api` provider routing + external providers | 4 | 21 | `apps/api/src/document-signing` = 10, `apps/api/src/esignature-providers` = 15 (same command); signature-router and signature-routing.service read; webhook controller headers read |
| `apps/sign-web` src files | 5 | 44 | same command on `apps/sign-web/src` = 49; read main.tsx, zones.ts, guest sign-api method index, guest App screen type + calls, workspace App route table |
| `libs/document-templates-web` src files | 0 | 12 | same command = 12; import usage only |
| D10 scope catalog | 4 groups | 0 | `git show 680907fc:libs/identity/src/lib/dto/scope.dto.ts \| grep -oE "^  '(sign\|document\|document_template\|document_requirement\|platform:document_template):[a-z_:]+'"` — `document:*` 4, `document_template:*` 3, `document_requirement:*` 2, `sign:*` 11; `platform:document_template:*` 2 seeded (`libs/identity/prisma/seed.ts:214`–`:215`) |
| `libs/documents-contracts` | 2 | 1 | `signature-provider.port.ts` interface index + `esign-service-request-auth.ts` header read; `sign-template-library.contract.ts` not read |
| `libs/documents-rendering` | 1 | 3 | adapter class confirmed via grep; port, safe-upload pipeline and bundled font not read |
| FE template + RTR + provider screens | 0 | 30 | `git ls-tree -r --name-only 680907fc -- apps/ats-web/src/{rtr,offer-document,integrations} apps/platform-web/src/document-templates libs/org-admin-web/src/document-templates \| grep -vE 'spec\|test'` = 30; presence + imports only |
| DOC-1b TalentDocument reconciliation | 1 | n | `git grep -n createResumeDocument 680907fc -- libs/talent-extraction` → `talent-extraction.service.ts:1285`; full reconciliation/erasure/merge wiring not audited |
| Pact contracts for D10 | 6 | 0 | `git show 680907fc:<file> \| grep -cE 'uponReceiving\('`: provider `sign-service` (`pact/provider/src/verify-sign.ts`) — `sign-consumer` 11, `sign-web-consumer` 6, `sign-workspace-consumer` 11 (= 28); provider `api` (`verify-api.ts`) — `sign-source-consumer` source-pull 2, template-library 4, webhook 2 (= 8). Interaction bodies not audited |
| Sign host nginx | 1 | 0 | `git show 680907fc:deploy/nginx/templates/aramo.conf.template` lines 259–400 read (proxied `/v1/sign/*` locations) |
| Terraform (Sign SNS/KMS/storage) | 0 | n | not audited |
