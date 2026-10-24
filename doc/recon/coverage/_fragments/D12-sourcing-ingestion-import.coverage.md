| surface | inspected | not_verified | method/command |
| --- | --- | --- | --- |
| D12 libraries | 7 | 0 | `ls libs/ \| grep -iE 'sourc\|ingest\|import\|cold\|resume\|attach\|object-storage'` → attachment, cold-ingest-extraction, import, ingestion, object-storage, resume-parse, sourced-talent |
| Prisma models (4 D12 schemas) | 5 | 0 | `grep -ch '^model ' libs/{ingestion,sourced-talent,import,attachment}/prisma/schema.prisma` → RawPayloadReference, SourcedTalent, ImportBatch, ImportFailure, Attachment |
| Service / repository files (7 libs) | 11 | 1 | `git ls-files` + `grep -E '\.(service\|repository)\.ts$'` → 12 files; all read except `libs/import/src/lib/import.service.ts` (842 lines) read head + targeted greps only |
| D12 HTTP routes (handler fully read) | 21 | 11 | per-controller `grep -cE '@(Post\|Get\|Delete\|Put\|Patch\|Sse)\('`: ingestion 2 + import 6 + requisition-import 3 + attachment 5 + indeed-apply 1 + sourcing 4 fully read = 21; talent-intake-drafts 10 + resume-upload-url 1 inspected at signature/route level only = 11 |
| DTO files (ingestion/import/attachment) | 5 | 8 | `git ls-files '*/dto/*' \| grep -v index.ts` → 13; ingestion request DTOs + import target/batch views read; 8 import/attachment DTO bodies not opened |
| OpenAPI paths | 2 | — | `grep -cE '^  /v1/' openapi/ingestion.yaml` → 2 (payloads, indeed/search-results); confirmed `/v1/imports*`, `/v1/attachments` collection, `/v1/talent-records/resume-upload-url`, `/v1/sourcing*` ABSENT via `grep -nE '^  /v1/(imports\|attachments)' openapi/ats.yaml` (empty) |
| FE wiring files (ats-web) | 1 | 2 | `apps/ats-web/src/settings/import-api.ts` read in full; `talent-api.ts` + `talent-intake-api.ts` route-grepped only |
| talent-extraction FACT extractor | 1 (partial) | 1 | `libs/talent-extraction/src/lib/talent-extraction.service.ts` (3048 lines) — head + `grep -n 'redactPii\|source_refs\|extractDeclaredEvidence'`; full body NOT read |
| no-llm-boundary specs | 0 | 3 | `git ls-files \| grep no-llm-boundary` → import, resume-parse, cold-ingest-extraction specs present; names verified, bodies NOT read |
| Integration / unit specs (7 libs) | 0 | 27 | `git ls-files` + `grep -E '\.spec\.ts$\|/tests/'` → 27 test files across the 7 libs; existence counted, contents NOT read this pass |
| Repo ADR anchors | 2 | 3 | ADR-0015 + ADR-0033 content read; ADR-0016, ADR-0018, ADR-0029 cited by role/title only |
| Terraform (s3-resume-bucket) | 0 | 1 | referenced in `object-storage.service.ts:83` comments; `infrastructure/modules/s3-resume-bucket` NOT opened |
