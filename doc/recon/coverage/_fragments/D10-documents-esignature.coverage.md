# D10 — Documents & E-Signature (COVERAGE)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212

| surface | inspected | not_verified | method/command |
|---|---|---|---|
| Core Documents OpenAPI endpoints | 22 | 0 | `grep -cE '^  /v1/' openapi/documents.yaml` = 22 (paths enumerated; not each cross-checked to controller) |
| E-Sign OpenAPI endpoints | 11 | 4 | `grep -cE '^  /v1/' openapi/esign.yaml` = 11; cross-checked vs 15 controller ops → 4 signer ops undocumented (G1) |
| Core Documents controller HTTP methods | 26 | 0 | `grep -cE '@(Get\|Post\|Put\|Patch\|Delete)\(' documents.controller.ts templates.controller.ts` = 26 (both files read in full) |
| E-Sign service controller HTTP methods | 15 | 0 | `grep -cE '@(Get\|Post\|Put\|Patch\|Delete)\(' apps/esign-service/src/app/esign-http.controller.ts` = 15 (file read in full) |
| `apps/api` D10 controllers | 4 | 0 | `ls apps/api/src/{documents,integrations/esign,rtr,offer-document}/*.controller.ts` = 4; all read (documents-esign, esign-events, rtr, offer-document) |
| `documents` schema models | 15 | 0 | `grep -c '^model ' libs/documents/prisma/schema.prisma` = 15 (schema read in full) |
| `esign` schema models | 12 | 0 | `grep -c '^model ' libs/esign/prisma/schema.prisma` = 12 (schema read in full) |
| `documents` migration SQL files | 0 | 6 | `ls libs/documents/prisma/migrations/ \| grep -c '^[0-9]'` = 6; SQL (triggers/CHECKs) not read, inferred from schema comments |
| `esign` migration SQL files | 0 | 5 | `ls libs/esign/prisma/migrations/ \| grep -c '^[0-9]'` = 5; SQL not read |
| `libs/documents` lib src files | 2 | 11 | `find libs/documents/src/lib -name '*.ts'` = 13; read 2 controllers; repository/render/idempotency/requirements/revision-source/executed-write-back/storage/prisma not read |
| `libs/esign` lib src files | 4 | 15 | `find libs/esign/src/lib -name '*.ts'` = 19; read esign.service, execution.service, outbox.service, outbox-delivery.service; hash-chain/signing-token via grep; repository/ports/module not fully read |
| `apps/esign-service` app src files | 5 | 7 | `find apps/esign-service/src/app -name '*.ts'` = 12; read esign-http.controller, native provider, app.module, sns-event-publisher, delivery.worker; kms-signer via grep; resolver/adapters/mapper/webhook-publisher not fully read |
| `apps/sign-web` src files | 2 | 2 | `find apps/sign-web/src -name '*.ts*' \| grep -v spec` = 4; read App.tsx + sign-api.ts; main.tsx/index.css not read |
| D10 scope catalog | 2 groups | 0 | `grep document libs/identity/src/lib/dto/scope.dto.ts` + `grep esign:envelope libs/identity/prisma/seed.ts` — ATS `document:*` (8) + E-Sign `esign:envelope:*` (3) confirmed seeded/bundled |
| `libs/documents-contracts` port | 1 | 0 | `signature-provider.port.ts` read in full (`SignatureProviderPort`, `CreateEnvelopeRequest`) |
| `libs/documents-rendering` | 1 | 2 | adapter class/method confirmed via grep (`pdf-lib-document-rendering.adapter.ts`); port + safe-upload.pipeline not fully read |
| `apps/ats-web` RTR/Offer FE | 0 | 4 | `find apps/ats-web/src -type d` + `grep -rl v1/rtr\|v1/offer-documents` → RtrPanel/rtr-api/offer-document-api present; component behavior NOT audited |
| DOC-1b TalentDocument reconciliation | 1 | n | `grep -rn TalentDocument libs apps` → `createResumeDocument` confirmed at `talent-extraction.service.ts:1439`; full reconciliation/erasure/merge wiring not audited |
| Pact contracts for D10 | 0 | n | not enumerated this pass |
| Terraform (E-Sign SNS/KMS) | 0 | n | not audited (MEMORY: authored-unapplied) |
