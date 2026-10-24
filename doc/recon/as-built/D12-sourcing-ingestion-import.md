# D12 — Sourcing, Ingestion, Import & Resume Parsing (AS-BUILT)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124 · category AS-BUILT
> Refreshed from baseline 12330b0f (2026-10-09) to 680907fc (2026-10-24): ATI-SEP-1 moved `sourced-talent` / `talent-extraction` to `scope:ats`, re-anchored canonicalization and sourcing promotion on the ATS-local `SourcedTalent` row (new `RawPayloadReference.sourced_talent_id`), removed the trust-ledger writes from the résumé extractor (prompt `resume-draft/v4`), added erasure-grade object purge, and changed the DOCX reader to keep contact-block line breaks (PR #1007).

## Summary

D12 covers the inbound-material surfaces of the platform: generic payload
ingestion, the Indeed channel (search-results push + Apply webhook), the
raw channel-arrival staging store, bulk CSV/VMS import, object storage
(presigned resume upload + server-side ingestion-object write), deterministic
resume text extraction, and the governed-LLM resume FACT extractor.

Seven libraries carry the domain substrate — `@aramo/ingestion`,
`@aramo/sourced-talent`, `@aramo/import`, `@aramo/cold-ingest-extraction`,
`@aramo/resume-parse`, `@aramo/object-storage`, `@aramo/attachment` — plus the
governed extractor `@aramo/talent-extraction` and the composition-root Indeed
Apply webhook under `apps/api/src/webhooks`. Seven of the eight libs are
directly imported into the API composition root
(`apps/api/src/app.module.ts`); `@aramo/resume-parse` is NOT a direct import —
it is wired transitively via `libs/talent-record/src/lib/talent-record.module.ts:49`
(ResumeParseModule), with app.module.ts referencing it only in a comment
(`apps/api/src/app.module.ts:567`).

nx tags at this SHA: `ingestion`, `cold-ingest-extraction`, `resume-parse`
are `scope:cip`; `sourced-talent`, `import`, `attachment`, `talent-extraction`
are `scope:ats`; `object-storage` is `scope:shared`
(`libs/<lib>/project.json:6`).

Load-bearing facts established by the read:

- **Ingestion is passive-intake only.** `IngestionService.acceptPayload`
  stores what is submitted and runs detect-and-flag dedup (sha256 →
  claimed-email → profile_url); it performs no crawl/search/discovery
  (`libs/ingestion/src/lib/ingestion.service.ts:56`).
- **`source_class` is server-derived, never caller-supplied.**
  `deriveSourceClass` maps a channel to its attestation level from the closed
  `INGESTION_SOURCE_CONTRACT`, fail-closed to `THIRD_PARTY_UNVERIFIED`
  (`libs/ingestion/src/lib/source-contract.ts:124`).
- **Cold-ingest extraction is PARKED/INERT.** The BullMQ worker's `process`
  tick reads no arrivals, writes nothing, and only logs
  (`libs/cold-ingest-extraction/src/lib/cold-ingest-extraction.processor.ts:41`).
  Its poll gate now selects arrivals with a non-null `sourced_talent_id`
  (`libs/ingestion/src/lib/ingestion.repository.ts:120`).
- **Resume parsing is split in two.** `@aramo/resume-parse` does deterministic
  bytes→text only (pdf-parse / mammoth, NO LLM); `@aramo/talent-extraction`
  is the governed-LLM FACT extractor that redacts PII before the model and
  grounds returned `source_refs` against the resume source-map
  (`libs/resume-parse/src/lib/resume-parser.service.ts:40`,
  `libs/talent-extraction/src/lib/talent-extraction.service.ts:365`). The
  extractor no longer writes any trust ledger (ATI-SEP-1 A1); declared work
  authorization is an ATS typed-row write only
  (`libs/talent-extraction/src/lib/talent-extraction.service.ts:550`).
- **The import engine never resolves identity.** Importing
  `target_entity='talent_record'` creates TalentRecord rows only; identity
  resolution is canonicalization's job
  (`libs/import/src/lib/import.service.ts:37`).
- **TalentRecord creation is NOT exclusive to import.** The import path is one
  writer; the durable Talent-intake promote path (and its new `manual` entry)
  and the sourcing promote path also create records — no single D12 surface is
  the sole creator
  (`libs/talent-record/src/lib/talent-intake/talent-intake.controller.ts:173`,
  `apps/api/src/talent-identity/sourcing.controller.ts:86`,
  `apps/api/src/talent-identity/promotion.service.ts:146`).
- **Sourcing is ATS-local.** Canonicalization resolves every ingestion arrival
  to a `sourced_talent.SourcedTalent` row keyed by (tenant, channel, external
  id) and writes `RawPayloadReference.sourced_talent_id` as the idempotency
  anchor; `resolved_subject_id` / `resolved_cluster_id` are inert soft refs
  (`libs/canonicalization/src/lib/canonicalization.repository.ts:158`,
  `libs/ingestion/prisma/schema.prisma:135`).

## Modules & Services

| name | role | evidence path:line + symbol |
| --- | --- | --- |
| `@aramo/ingestion` IngestionController | HTTP front door for generic + Indeed search-results intake under `/v1/ingestion` | `libs/ingestion/src/lib/ingestion.controller.ts:37` `@Controller('v1/ingestion')` |
| `@aramo/ingestion` IngestionService | Passive intake + detect-and-flag dedup; registers source-derived consent for Indeed | `libs/ingestion/src/lib/ingestion.service.ts:50` `IngestionService` |
| `@aramo/ingestion` IngestionRepository | RawPayloadReference writes, dedup queries, cold-ingest extraction poll gates (gate on `sourced_talent_id`) | `libs/ingestion/src/lib/ingestion.repository.ts:73` `IngestionRepository` |
| `@aramo/ingestion` source-contract | Single canonical source/channel contract; derives wire allowlist + source_class map | `libs/ingestion/src/lib/source-contract.ts:63` `INGESTION_SOURCE_CONTRACT` |
| `@aramo/sourced-talent` SourcedTalentRepository | ATS-local sourcing store (`scope:ats`): idempotent `recordArrival`, pool reads (`listByTenantKeyset` `:161`), `findByIngestionPayloadId` `:133`, `findByNormalizedContact` `:191` | `libs/sourced-talent/src/lib/sourced-talent.repository.ts:61` `recordArrival` |
| `@aramo/canonicalization` CanonicalizationRepository | Resolves each unresolved arrival to a `SourcedTalent` row and stamps `sourced_talent_id` (idempotent; last write) | `libs/canonicalization/src/lib/canonicalization.repository.ts:158` `canonicalize`; batch select `:137` `findUnresolvedPayloadBatch` |
| `@aramo/import` ImportController | Generic CSV import engine: run, suggest-mapping, read, revert | `libs/import/src/lib/import.controller.ts:72` `@Controller('v1/imports')` |
| `@aramo/import` RequisitionImportController | Provider-neutral canonical requisition import (VMS) | `libs/import/src/lib/requisition-import.controller.ts:48` `@Controller('v1/requisition-imports')` |
| `@aramo/import` ImportService | Per-row partial-commit engine + per-target `createForImport` + revert | `libs/import/src/lib/import.service.ts:221` `runImport` |
| `@aramo/import` MappingSuggestionService | Deterministic heuristic column→field mapping (NO LLM) | `libs/import/src/lib/mapping/mapping-suggestion.service.ts:16` design comment |
| `@aramo/cold-ingest-extraction` processor | PARKED BullMQ tick worker — inert (logs only) | `libs/cold-ingest-extraction/src/lib/cold-ingest-extraction.processor.ts:41` `process` |
| `@aramo/resume-parse` ResumeParserService | Deterministic object-bytes→text + artifact sha256 (NO LLM) | `libs/resume-parse/src/lib/resume-parser.service.ts:40` `extractTextFromStorageKey` |
| `@aramo/resume-parse` text-extractor | Magic-byte format sniff + pdf-parse / mammoth extraction; DOCX body `<w:br/>`/`<w:cr/>` rewritten as newlines before mammoth (`withBodyLineBreaksAsText` `:124`), header/footer run walker (`docxXmlRunsToText` `:150`) | `libs/resume-parse/src/lib/heuristics/text-extractor.ts:54` `extractResumeText` |
| `@aramo/resume-parse` source-map | Deterministic text→ordered source blocks (grounding corpus) | `libs/resume-parse/src/lib/source-map.ts:57` `buildResumeSourceMap` |
| `@aramo/object-storage` ObjectStorageService | Presigned resume PUT/GET, server-side ingestion-object PUT, orphan-sweep tagging, erasure-grade all-versions purge (`purgeObjectAllVersions` `:379`, caller `apps/api/src/talent-anchor/erase-talent.command.ts:88`) | `libs/object-storage/src/lib/object-storage.service.ts:55` `ObjectStorageService` |
| `@aramo/object-storage` key-convention | Tenant-scoped S3 key builders (resume + ingestion) | `libs/object-storage/src/lib/key-convention.ts:68` `buildResumeObjectKey` |
| `@aramo/attachment` AttachmentController | Polymorphic file-attachment CRUD + resume download-url + reindex enqueue | `libs/attachment/src/lib/attachment.controller.ts:53` `@Controller('v1/attachments')` |
| `@aramo/talent-extraction` TalentExtractionService | Governed-LLM resume FACT extractor (PII redaction + source_ref grounding; prompt `resume-draft/v4` `:127`; no ledger write) | `libs/talent-extraction/src/lib/talent-extraction.service.ts:365` `extractDeclaredEvidence`; `:607` `extractResumeDraft` |
| `@aramo/ai-draft` redactPii | Pre-model PII redaction; a US phone glued to an email local part is split and redacted as phone + email (PR #1007) | `libs/ai-draft/src/lib/redaction.ts:40` `redactPii`; `:24` `GLUED_PHONE_PREFIX_RE` |
| apps/api IndeedApplyController | Unguarded HMAC-authenticated Indeed Apply inbound webhook | `apps/api/src/webhooks/indeed-apply.controller.ts:36` `@Post('apply')` |
| apps/api IndeedApplyWebhookService | SRC-1 spine orchestration: storage → ingestion front door → sourced_talent dedup | `apps/api/src/webhooks/indeed-apply.service.ts:64` `process` |
| apps/api SourcingController | Sourcing pool reads + promotes a `SourcedTalent` arrival into a TalentRecord (pipeline / bench) | `apps/api/src/talent-identity/sourcing.controller.ts:42` `@Controller('v1/sourcing')` |
| apps/api PromotionService | Sourced→record promotion on ATS data only: gates (unknown / already promoted / unresolved / no name / no basis / incomplete contact / active duplicate → 409 + advisory), `talentRecords.create` with `sourced_arrival` link, then source-derived consent | `apps/api/src/talent-identity/promotion.service.ts:73` `promoteArrival`; `:122` duplicate; `:146` create; `:173` consent |

## Data Models

| model | schema | purpose | evidence path:line |
| --- | --- | --- | --- |
| `RawPayloadReference` | `ingestion` | Raw payload stored by reference (storage_ref + sha256); dedup + cold-ingest poll gates (`sourced_talent_id` `:135` + index `:156`, `extraction_done_at`, `extraction_attempts`); `resolved_subject_id` / `resolved_cluster_id` inert | `libs/ingestion/prisma/schema.prisma:61` |
| `ResolutionMethod` (enum) | `ingestion` | How canonicalize resolved a payload (writable: `new_identity`, `confirmed_anchor_match`) | `libs/ingestion/prisma/schema.prisma:32` |
| `SourcedTalent` | `sourced_talent` | Immutable per-arrival ATS sourcing row; dedup key `(tenant_id, source_channel, external_source_id)` | `libs/sourced-talent/prisma/schema.prisma:53` |
| `ImportBatch` | `import` | First-class audit + reversion handle; status lifecycle | `libs/import/prisma/schema.prisma:93` |
| `ImportFailure` | `import` | One row per failed import row (reason + offending_fields + original_row_data) | `libs/import/prisma/schema.prisma:156` |
| `ImportTargetEntity` / `ImportBatchStatus` (enums) | `import` | 4 targets (company/contact/requisition/talent_record); 5 statuses | `libs/import/prisma/schema.prisma:46` (ImportTargetEntity) + `:68` (ImportBatchStatus) |
| `Attachment` | `attachment` | Polymorphic file metadata + `storage_key` (not bytes); `is_resume` flag | `libs/attachment/prisma/schema.prisma:56` |
| `AttachmentOwnerType` (enum) | `attachment` | talent / requisition / company / contact (only `talent` wired) | `libs/attachment/prisma/schema.prisma:42` |

Note: `RawPayloadReference.verified_email` is a documented misnomer — it holds
the channel-CLAIMED email (normalized), NOT a verified one; verification level
is carried by `source_class` (`libs/ingestion/prisma/schema.prisma` field
comment; `libs/ingestion/src/lib/dto/ingestion-payload-request.dto.ts` note).

## API Endpoints

| method | route | scopes | evidence path:line |
| --- | --- | --- | --- |
| POST | `/v1/ingestion/payloads` | JwtAuthGuard only (no scope decorator) | `libs/ingestion/src/lib/ingestion.controller.ts:42` |
| POST | `/v1/ingestion/indeed/search-results` | JwtAuthGuard only | `libs/ingestion/src/lib/ingestion.controller.ts:55` |
| POST | `/v1/webhooks/indeed/apply` | unguarded; HMAC `X-Indeed-Signature` | `apps/api/src/webhooks/indeed-apply.controller.ts:36` |
| GET | `/v1/imports` | `import:read` + site-match | `libs/import/src/lib/import.controller.ts:85` |
| GET | `/v1/imports/:id` | `import:read` | `libs/import/src/lib/import.controller.ts:100` |
| GET | `/v1/imports/:id/failures` | `import:read` | `libs/import/src/lib/import.controller.ts:124` |
| POST | `/v1/imports` | `import:create` + site-match | `libs/import/src/lib/import.controller.ts:145` |
| POST | `/v1/imports/suggest-mapping` | `import:create` | `libs/import/src/lib/import.controller.ts:228` |
| POST | `/v1/imports/:id/revert` | `import:delete` | `libs/import/src/lib/import.controller.ts:268` |
| GET | `/v1/requisition-imports` | `requisition:import:read` | `libs/import/src/lib/requisition-import.controller.ts:54` |
| GET | `/v1/requisition-imports/:id` | `requisition:import:read` | `libs/import/src/lib/requisition-import.controller.ts:69` |
| POST | `/v1/requisition-imports` | `requisition:import:write` | `libs/import/src/lib/requisition-import.controller.ts:92` |
| GET | `/v1/attachments` | `attachment:read` + site-match | `libs/attachment/src/lib/attachment.controller.ts:69` |
| GET | `/v1/attachments/:id` | `attachment:read` | `libs/attachment/src/lib/attachment.controller.ts:103` |
| GET | `/v1/attachments/:id/download-url` | `attachment:read` | `libs/attachment/src/lib/attachment.controller.ts:131` |
| POST | `/v1/attachments` | `attachment:create` | `libs/attachment/src/lib/attachment.controller.ts:158` |
| DELETE | `/v1/attachments/:id` | `attachment:delete` | `libs/attachment/src/lib/attachment.controller.ts:226` |
| POST | `/v1/talent-records/resume-upload-url` | `attachment:create` | `libs/talent-record/src/lib/talent-record.controller.ts:1611` |
| POST/GET/SSE | `/v1/talent-intake-drafts*` (create / manual / complete-upload / promote / events …) | `talent:create` / `talent:read` / `talent:edit` | `libs/talent-record/src/lib/talent-intake/talent-intake.controller.ts:40`; `manual` `:65` |
| GET | `/v1/sourcing/pool`, `/v1/sourcing/pool/:subjectId` | `talent:source` | `apps/api/src/talent-identity/sourcing.controller.ts:59`, `:76` |
| POST | `/v1/sourcing/pipeline`, `/v1/sourcing/bench` | `talent:source` | `apps/api/src/talent-identity/sourcing.controller.ts:86`, `:176` |

## Screens & FE→BE Wiring (ats-web)

| FE module | consumes | evidence path:line |
| --- | --- | --- |
| `settings/import-api.ts` + `ImportSection.tsx` | GET `/v1/imports`, GET `/v1/imports/:id/failures` — READ-ONLY (run/config deliberately deferred, "no dead knob") | `apps/ats-web/src/settings/import-api.ts:17` `fetchImports` |
| `talent/talent-api.ts` | POST `/v1/talent-records/resume-upload-url`; GET/POST `/v1/attachments`; GET `/v1/attachments/:id/download-url` | `apps/ats-web/src/talent/talent-api.ts:270` resume-upload-url path |
| `talent/talent-intake-api.ts` | `/v1/talent-intake-drafts*` durable-async intake flow (create → complete-upload → GET/SSE → promote) | `apps/ats-web/src/talent/talent-intake-api.ts:102` `BASE = '/v1/talent-intake-drafts'` |
| `sourcing/sourcing-api.ts` | GET `/v1/sourcing/pool`, GET `/v1/sourcing/pool/:subjectId`, POST `/v1/sourcing/pipeline`, POST `/v1/sourcing/bench` (+ advisory routes) | `apps/ats-web/src/sourcing/sourcing-api.ts:45` `addToPipeline` POST `/v1/sourcing/pipeline`, `:53` `saveToBench` POST `/v1/sourcing/bench` |
| `requisition-imports/requisition-imports-api.ts` | GET `/v1/requisition-imports`, GET `/v1/requisition-imports/:id` (READ-ONLY) | `apps/ats-web/src/requisition-imports/requisition-imports-api.ts:19` `listRequisitionImports`, `:24` `getRequisitionImport` |

No ats-web FE consumer was found for POST `/v1/imports`, `/v1/imports/suggest-mapping`,
`/v1/imports/:id/revert`, or POST `/v1/requisition-imports` (grep of
`apps/ats-web/src`). The GET sides of `/v1/requisition-imports` and the
`/v1/sourcing/*` surface (pool, pool drill-in, pipeline, bench) ARE consumed —
see the `sourcing/` and `requisition-imports/` rows above.

## Key Flows

### Flow 1 — Indeed Apply webhook (SRC-1 ingestion spine)

```mermaid
sequenceDiagram
    participant Indeed
    participant Ctl as IndeedApplyController
    participant Svc as IndeedApplyWebhookService
    participant OS as ObjectStorageService
    participant Ing as IngestionService
    participant ST as SourcedTalentRepository
    Indeed->>Ctl: POST /v1/webhooks/indeed/apply (raw body + X-Indeed-Signature)
    Ctl->>Svc: process({rawBody, signatureHeader, host})
    Svc->>Svc: secret unset? 503 · bad HMAC? 401 · unknown slug? 404 · no apply_id? 400
    Svc->>OS: putIngestionObject (raw bytes verbatim, server sha256)
    OS-->>Svc: {storage_ref, sha256}
    Svc->>Ing: acceptPayload(source='indeed', storage_ref, sha256)
    Ing->>Ing: dedup sha256; source_class=THIRD_PARTY_UNVERIFIED
    Ing-->>Svc: {ingestion_payload_id}
    Svc->>ST: recordArrival (channel dedup memory; idempotent)
    ST-->>Svc: {arrival_id}
    Svc-->>Ctl: 200 {arrival_id, ingestion_payload_id}
```

Evidence: `apps/api/src/webhooks/indeed-apply.service.ts:64` (process),
`:99` (putIngestionObject), `:119` (acceptPayload), `:127` (recordArrival).

### Flow 1b — Canonicalize → sourcing pool → promotion (ATS-local)

```mermaid
sequenceDiagram
    participant CR as CanonicalizationRepository
    participant RP as RawPayloadReference
    participant ST as SourcedTalent
    participant FE as ats-web sourcing
    participant SC as SourcingController
    participant PS as PromotionService
    participant TR as TalentRecordRepository
    CR->>RP: findUnresolvedPayloadBatch (sourced_talent_id IS NULL)
    CR->>ST: recordArrival (idempotent on tenant+channel+external id)
    CR->>RP: stamp sourced_talent_id (last write = idempotency anchor)
    FE->>SC: GET /v1/sourcing/pool
    SC->>ST: listByTenantKeyset
    FE->>SC: POST /v1/sourcing/pipeline | /bench
    SC->>PS: promoteArrival (gates: name, basis, email1+cell, active duplicate)
    alt active duplicate
      PS-->>FE: 409 TALENT_RECORD_DUPLICATE + SOURCED_ARRIVAL advisory
    else
      PS->>TR: create (sourced_arrival link) + talent.created outbox row
      PS->>PS: registerSourceDerivedConsent
    end
```

Evidence: `libs/canonicalization/src/lib/canonicalization.repository.ts:137`
+ `:158`, `libs/sourced-talent/src/lib/sourced-talent.repository.ts:61` + `:161`,
`apps/api/src/talent-identity/sourcing.service.ts:113` + `:210` + `:230` + `:275`,
`apps/api/src/talent-identity/promotion.service.ts:73` + `:122` + `:146` + `:153` + `:173`.

### Flow 2 — Resume upload → text → governed FACT extraction

```mermaid
sequenceDiagram
    participant FE as ats-web
    participant TR as TalentRecordController
    participant OS as ObjectStorageService
    participant AT as AttachmentController
    participant RP as ResumeParserService
    participant TX as TalentExtractionService
    participant AI as AiDraftService
    FE->>TR: POST /v1/talent-records/resume-upload-url {filename, content_type}
    TR->>OS: createResumePresignedPut (orphan-pending tag baked in)
    OS-->>FE: {storage_key, presigned_url}
    FE->>OS: PUT bytes directly to S3
    FE->>AT: POST /v1/attachments (is_resume=true, owner=talent)
    AT->>OS: markResumeCommitted (clear orphan tag)
    AT->>AT: enqueueReindex (ResumeTextService; async, best-effort)
    Note over RP,AI: durable-async intake worker path
    RP->>OS: createPresignedGet + fetch bytes
    RP->>RP: extractResumeText (pdf-parse / mammoth, NO LLM)
    RP-->>TX: extracted text + source-map
    TX->>TX: redactPii(block text) before model
    TX->>AI: single-read structured generation (FACT + source_refs)
    TX->>TX: ground source_refs against source-map blocks
```

Evidence: `libs/talent-record/src/lib/talent-record.controller.ts:1611`,
`libs/object-storage/src/lib/object-storage.service.ts:61` + `:503` + `:428`,
`libs/attachment/src/lib/attachment.controller.ts:158` + `:208`,
`libs/resume-parse/src/lib/resume-parser.service.ts:40`,
`libs/resume-parse/src/lib/heuristics/text-extractor.ts:54`,
`libs/talent-extraction/src/lib/talent-extraction.service.ts:607` + `:639`.

Output-cap handling: the résumé-draft call uses `max_tokens`
`RESUME_DRAFT_V3_MAX_TOKENS = 16384`
(`libs/talent-extraction/src/lib/talent-extraction.service.ts:137`, used `:655`);
a truncated provider outcome maps to `provider_truncated` (`:2806`), which the
intake treats as an extraction failure (draft FAILED, résumé stays attached,
form editable) — `libs/talent-record/src/lib/talent-intake/talent-intake-review.ts:263`,
`libs/talent-record/src/lib/dto/talent-intake.dto.ts:230`.

PDF reading: the PDF branch is still the library-default `pdfParse(buffer)`
with a `null`-on-empty contract (`libs/resume-parse/src/lib/heuristics/text-extractor.ts:59`);
no custom page renderer, page-completeness check or
`RESUME_TEXT_EXTRACTOR_VERSION` export exists at this SHA (`git grep` → 0 hits).

### Flow 3 — Object-storage component map

```mermaid
flowchart TD
    subgraph S3[S3 bucket $S3_RESUME_BUCKET]
      RK["resume key: {tenant}/talent/{trId}/resume/{uuid}-{file}"]
      IK["ingestion key: {tenant}/ingestion/{channel}/{extId}/{uuid}.json"]
    end
    KC[key-convention.ts] -->|buildResumeObjectKey| RK
    KC -->|buildIngestionObjectKey| IK
    OSS[ObjectStorageService] -->|createResumePresignedPut PUT| RK
    OSS -->|createPresignedGet GET| RK
    OSS -->|putIngestionObject server PUT| IK
    OSS -->|markResumeCommitted tagging| RK
    OSS -->|purgeObjectAllVersions erasure| RK
    LC["S3 lifecycle Rule 5: orphan-pending sweep"] -.->|expires untagged| RK
    S3F[S3ClientFactory] --> OSS
    CFG["object-storage.config: S3_RESUME_BUCKET / AWS_REGION / S3_ENDPOINT"] --> S3F
```

Evidence: `libs/object-storage/src/lib/key-convention.ts:68` + `:104`,
`libs/object-storage/src/lib/object-storage.service.ts:61` + `:145` + `:428` + `:503`
(+ `purgeObjectAllVersions` `:379`, used by the erasure CLI),
`libs/object-storage/src/lib/object-storage.config.ts:60`.

### Flow 4 — ImportBatch lifecycle

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> committed: all rows succeed
    pending --> partially_committed: failures below threshold
    pending --> rejected: failures exceed threshold (whole batch rolled back)
    committed --> reverted: POST /v1/imports/:id/revert
    partially_committed --> reverted: POST /v1/imports/:id/revert
    reverted --> [*]
    rejected --> [*]
    committed --> [*]
```

Evidence: `libs/import/prisma/schema.prisma:68` (ImportBatchStatus enum),
`libs/import/src/lib/import.service.ts:221` (runImport),
`libs/import/src/lib/import.controller.ts:268` (revert).

## Evidence Index

- `libs/ingestion/src/lib/ingestion.controller.ts:37` — `@Controller('v1/ingestion')`
- `libs/ingestion/src/lib/ingestion.controller.ts:42` — `@Post('payloads')` submitPayload
- `libs/ingestion/src/lib/ingestion.controller.ts:55` — `@Post('indeed/search-results')`
- `libs/ingestion/src/lib/ingestion.service.ts:56` — `acceptPayload` (passive intake + dedup)
- `libs/ingestion/src/lib/ingestion.service.ts:177` — `acceptIndeedSearchResults`
- `libs/ingestion/src/lib/ingestion.service.ts:226` — `registerSourceDerivedConsent` call
- `libs/ingestion/src/lib/source-contract.ts:63` — `INGESTION_SOURCE_CONTRACT`
- `libs/ingestion/src/lib/source-contract.ts:124` — `deriveSourceClass` (fail-closed)
- `libs/ingestion/src/lib/source-class.map.ts:18` — re-export of `deriveSourceClass`
- `libs/ingestion/src/lib/ingestion.repository.ts:76` — `createPayload`
- `libs/ingestion/src/lib/ingestion.repository.ts:111` — `findArrivalsNeedingExtraction` (gate `sourced_talent_id` not null `:120`)
- `libs/ingestion/src/lib/ingestion.repository.ts:148` — `markExtractionDone`
- `libs/ingestion/src/lib/ingestion.repository.ts:166` — `findBySha256`
- `libs/ingestion/src/lib/dto/ingestion-payload-request.dto.ts:35` — `@IsIn(INGESTION_SOURCES)` wire gate
- `libs/ingestion/prisma/schema.prisma:32` — `ResolutionMethod` enum
- `libs/ingestion/prisma/schema.prisma:61` — `model RawPayloadReference`
- `libs/ingestion/prisma/schema.prisma:135` — `sourced_talent_id` (migration `20261024160000_ati_sep_1_raw_payload_sourced_talent_id`)
- `libs/canonicalization/src/lib/canonicalization.repository.ts:158` — `canonicalize` (resolves to SourcedTalent)
- `libs/sourced-talent/src/lib/sourced-talent.repository.ts:11` — ATS-local sourcing store header
- `libs/sourced-talent/src/lib/sourced-talent.repository.ts:61` — `recordArrival` (idempotent)
- `libs/sourced-talent/src/lib/sourced-talent.repository.ts:161` — `listByTenantKeyset` (pool)
- `libs/sourced-talent/prisma/schema.prisma:53` — `model SourcedTalent`
- `libs/import/src/lib/import.controller.ts:72` — `@Controller('v1/imports')`
- `libs/import/src/lib/import.controller.ts:145` — POST run
- `libs/import/src/lib/import.controller.ts:228` — POST suggest-mapping
- `libs/import/src/lib/import.controller.ts:268` — POST revert (`import:delete`)
- `libs/import/src/lib/import.service.ts:37` — talent_record no-identity-resolution boundary comment
- `libs/import/src/lib/import.service.ts:221` — `runImport`
- `libs/import/src/lib/import.service.ts:412` — `runCanonicalRequisitionImport`
- `libs/import/src/lib/mapping/mapping-suggestion.service.ts:16` — deterministic (NO LLM) design comment
- `libs/import/src/lib/requisition-import.controller.ts:92` — POST requisition import
- `libs/import/prisma/schema.prisma:46` — `ImportTargetEntity` enum
- `libs/import/prisma/schema.prisma:68` — `ImportBatchStatus` enum
- `libs/import/prisma/schema.prisma:93` — `model ImportBatch`
- `libs/import/prisma/schema.prisma:156` — `model ImportFailure`
- `libs/cold-ingest-extraction/src/lib/cold-ingest-extraction.processor.ts:8` — PARKED/INERT header
- `libs/cold-ingest-extraction/src/lib/cold-ingest-extraction.processor.ts:41` — inert `process` tick
- `libs/resume-parse/src/lib/resume-parser.service.ts:40` — `extractTextFromStorageKey`
- `libs/resume-parse/src/lib/resume-parser.service.ts:70` — `extractTextAndSha256FromStorageKey`
- `libs/resume-parse/src/lib/resume-parser.service.ts:86` — `fetchBytes` (presigned GET + fetch)
- `libs/resume-parse/src/lib/heuristics/text-extractor.ts:23` — `detectResumeFormat`
- `libs/resume-parse/src/lib/heuristics/text-extractor.ts:54` — `extractResumeText` (pdf-parse / mammoth)
- `libs/resume-parse/src/lib/source-map.ts:57` — `buildResumeSourceMap`
- `libs/object-storage/src/lib/object-storage.service.ts:61` — `createResumePresignedPut`
- `libs/object-storage/src/lib/object-storage.service.ts:145` — `putIngestionObject`
- `libs/object-storage/src/lib/object-storage.service.ts:379` — `purgeObjectAllVersions` (erasure)
- `libs/object-storage/src/lib/object-storage.service.ts:428` — `createPresignedGet`
- `libs/object-storage/src/lib/object-storage.service.ts:503` — `markResumeCommitted`
- `libs/object-storage/src/lib/key-convention.ts:68` — `buildResumeObjectKey`
- `libs/object-storage/src/lib/key-convention.ts:104` — `buildIngestionObjectKey`
- `libs/object-storage/src/lib/object-storage.config.ts:60` — `S3_RESUME_BUCKET` resolution
- `libs/attachment/src/lib/attachment.controller.ts:53` — `@Controller('v1/attachments')`
- `libs/attachment/src/lib/attachment.controller.ts:131` — GET download-url
- `libs/attachment/src/lib/attachment.controller.ts:158` — POST create
- `libs/attachment/src/lib/attachment.controller.ts:208` — `resumeText.enqueueReindex`
- `libs/attachment/prisma/schema.prisma:42` — `AttachmentOwnerType` enum
- `libs/attachment/prisma/schema.prisma:56` — `model Attachment`
- `libs/talent-extraction/src/lib/talent-extraction.service.ts:127` — `RESUME_DRAFT_PROMPT_VERSION = 'resume-draft/v4'`
- `libs/talent-extraction/src/lib/talent-extraction.service.ts:137` — `RESUME_DRAFT_V3_MAX_TOKENS = 16384`
- `libs/talent-extraction/src/lib/talent-extraction.service.ts:365` — `extractDeclaredEvidence`
- `libs/talent-extraction/src/lib/talent-extraction.service.ts:607` — `extractResumeDraft`
- `libs/talent-extraction/src/lib/talent-extraction.service.ts:639` — `redactPii` applied before model
- `libs/talent-extraction/src/lib/talent-extraction.service.ts:2806` — truncated → `provider_truncated`
- `libs/ai-draft/src/lib/redaction.ts:24` — `GLUED_PHONE_PREFIX_RE` (PR #1007)
- `libs/resume-parse/src/lib/heuristics/text-extractor.ts:124` — `withBodyLineBreaksAsText` (PR #1007)
- `libs/resume-parse/src/lib/heuristics/text-extractor.ts:150` — `docxXmlRunsToText` (PR #1007)
- `apps/api/src/webhooks/indeed-apply.controller.ts:36` — `@Post('apply')`
- `apps/api/src/webhooks/indeed-apply.service.ts:64` — `process` (anti-oracle order)
- `apps/api/src/webhooks/indeed-apply.service.ts:99` — `putIngestionObject` call
- `apps/api/src/webhooks/indeed-apply.service.ts:119` — `acceptPayload` call
- `apps/api/src/webhooks/indeed-apply.service.ts:127` — `recordArrival` call
- `apps/api/src/talent-identity/sourcing.controller.ts:42` — `@Controller('v1/sourcing')`
- `apps/api/src/talent-identity/sourcing.controller.ts:86` — POST pipeline (`addToPipeline` `:89`; promotes → TalentRecord)
- `apps/api/src/talent-identity/promotion.service.ts:73` — `promoteArrival` (ATS-local gates)
- `libs/talent-record/src/lib/talent-record.controller.ts:1611` — `resume-upload-url` route (`createResumeUploadUrl` `:1615`)
- `libs/talent-record/src/lib/talent-intake/talent-intake.controller.ts:40` — `@Controller('v1/talent-intake-drafts')`
- `libs/talent-record/src/lib/talent-intake/talent-intake.controller.ts:173` — POST promote (creates TalentRecord)
- `apps/ats-web/src/settings/import-api.ts:17` — `fetchImports` (FE read-only)
- `apps/ats-web/src/talent/talent-api.ts:270` — resume-upload-url FE call
- `apps/ats-web/src/talent/talent-intake-api.ts:102` — intake FE base path
- `libs/identity/src/lib/dto/scope.dto.ts:283` — `'import:read'` seeded (create/delete absent)
- `apps/api/src/app.module.ts:228` — IngestionModule wired into composition root
- `openapi/ingestion.yaml:16` — `/v1/ingestion/payloads` documented
- `openapi/ingestion.yaml:93` — `/v1/ingestion/indeed/search-results` documented

## NOT VERIFIED (explicit)

- **Live S3 CORS state** on the production `aramo-prod-resumes-use1` bucket is a
  runtime/infra fact (flagged in standing memory as a broken upload), not
  derivable from repository code; the resume-upload presign path itself is
  present and correct in code. NOT VERIFIED here.
- **Terraform `s3-resume-bucket` lifecycle Rule 5 + orphan retention days** are
  referenced in code comments
  (`libs/object-storage/src/lib/object-storage.service.ts:80`) but the IaC
  module contents were not read in this pass. NOT VERIFIED.
- **Runtime behaviour of the durable-async intake worker** (outbox → worker →
  `ResumeExtractionOrchestrator.extractResume`) is wired through
  `libs/talent-record` and `@aramo/talent-extraction`; the orchestrator's own
  file was not fully read (its truncation branch at
  `libs/talent-record/src/lib/resume-extraction/resume-extraction.orchestrator.ts:87`
  was read). The D12-owned seams (object-storage, resume-parse,
  talent-extraction entry) are verified; the orchestration glue is NOT VERIFIED
  end-to-end here.
- **Pact contract coverage** for the D12 HTTP surfaces was not enumerated in
  this pass. NOT VERIFIED.
- Whether any non-ats-web FE (platform-admin/portal) consumes import or
  sourcing endpoints — only `apps/ats-web/src` was grepped. NOT VERIFIED for
  other FE apps.
- Whether the S3 resume bucket has versioning enabled (which
  `purgeObjectAllVersions` assumes for completeness) is infra state, NOT VERIFIED.
- Canonicalization tick cadence and the `CanonicalizationService` callers were
  traced to `libs/canonicalization/src/lib/canonicalization.repository.ts:158`
  only; the scheduling registration is NOT VERIFIED here.
