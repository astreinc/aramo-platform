# ADR-0015 — AI Substrate Posture: Anthropic SDK + AWS Secrets Manager + libs/ai-draft

**State:** ACCEPTED. v1.1 (extends v1.0-LOCKED at M5 PR-5 substrate audit closure, HEAD `daadb1b`; Decision 10 added at A8-3b, HEAD `25e6cadd`).
**Date:** 2026-05-25 (initial); 2026-06-04 (v1.1 — Decision 10).
**Authors:** Lead.
**Cross-references:** Charter v1.2 Ruling C (Anthropic + AWS Secrets Manager day-one); ADR-0012 (IaC conventions; Decision 3 bootstrap-outside-TF, Decision 7 Secrets Manager IaC M7-sequenced); ADR-0013 (observability conventions; Decision 2 envelope discipline, Decision 5 log-group naming).

---

## §1. Context

M5 PR-5 introduces the workspace's first AI-substrate consumption surface. Per Charter v1.2 Ruling C, the AI provider is Anthropic (locked); API key management is AWS Secrets Manager (locked, no env-var fallback). PR-5 ships `libs/ai-draft` substrate + service-layer abstraction; M5 PR-6+ consumers (outreach surface) consume via the service.

Two substrate-tension points surfaced at M5 PR-5 substrate audit:

1. **ADR-0012 Decision 7 sequencing tension.** AWS Secrets Manager IaC Terraform module is sequenced to M7 in the module-population precedence table; Charter Ruling C requires PR-5 (M5) runtime consumption. The collision is mechanical (Terraform-managed-secret vs. Terraform-managed-policy-around-secret) but needs explicit resolution.

2. **Provider-swap requirement vs. drop-in coupling.** Charter Ruling C requires Anthropic-day-one but anticipates future provider flexibility. The substrate must isolate Anthropic SDK behind a service-layer interface so a future provider swap is mechanical (new adapter file + module token swap), not architectural.

This ADR documents the resolution of both points + the related substrate-posture decisions (secret-name convention, caching strategy, redaction posture, observability discipline, model-version pinning).

---

## §2. Decisions

### Decision 1 — Provider locked at Anthropic; service-layer adapter pattern

PR-5 ships `libs/ai-draft` with a service-layer interface `DraftProvider` consumed by `AiDraftService.generateDraft`. The Anthropic adapter lives at `libs/ai-draft/src/lib/providers/anthropic.provider.ts`. Future providers slot in by adding a new adapter file + a new provider token in `AiDraftModule.providers`.

**Interface contract:**

```typescript
interface DraftProvider {
  generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult>;
}

interface ProviderGenerateInput {
  model: string;
  prompt: string;
  max_tokens: number;
  system_message?: string;
}

interface ProviderGenerateResult {
  completion: string;
  model_used: string;
  input_tokens: number;
  output_tokens: number;
  provider_request_id?: string;  // Anthropic returns this; other providers may differ
}
```

`AiDraftService` is the only consumer of `DraftProvider`. Cross-lib consumers (outreach surface at M5 PR-6+) consume `AiDraftService`, never `DraftProvider` directly.

### Decision 2 — AWS Secrets Manager bootstrap-outside-Terraform at PR-5; M7 IaC formalizes surrounding policy

**Resolves the ADR-0012 Decision 7 sequencing tension.**

PR-5 mirrors **ADR-0012 Decision 3 bootstrap-outside-Terraform precedent** (S3 buckets + DynamoDB lock are bootstrapped pre-Terraform; the secret value follows the same pattern).

PR-5 ships:
- `infrastructure/bootstrap/create-anthropic-secret.sh` — one-time idempotent script. Creates `aramo/<env>/anthropic-api-key` via AWS CLI `aws secretsmanager create-secret`. Idempotent: if the secret exists, the script reports presence and exits 0.
- `doc/runbooks/bootstrap-anthropic-secret.md` — runbook documenting: prerequisites (AWS CLI configured, IAM permissions), execution per environment (dev/staging/prod), rotation procedure (manual at PR-5; M7 IaC adds automated rotation).

**M7 scope (unchanged by this ADR):** Terraform module `infrastructure/modules/aws-secrets-manager/` adds KMS key rotation policy, IAM resource policies for the secret, audit-trail wiring, automated rotation schedule. The secret VALUE is bootstrap-managed; the SURROUNDING POLICY is Terraform-managed at M7.

**ADR-0012 Decision 7 is NOT amended.** The M7 sequencing of the Terraform module stands; PR-5 ships a transitional runtime consumption posture per the bootstrap-outside-TF pattern Decision 3 already establishes.

### Decision 3 — Secret-name convention: `aramo/<env>/anthropic-api-key`

Mirrors **ADR-0013 Decision 5 log-group naming** (`/aramo/<surface>/<env>`). Env-keyed naming is the workspace-established pattern.

`<env>` values: `dev`, `staging`, `prod`. PR-5 bootstraps all three at the script level; environment-specific deployment runs the script in the appropriate AWS account.

### Decision 4 — Cache-at-process-start; no TTL refresh

`AiDraftService` constructor receives a `SecretCacheService` (or equivalent name) that fetches the secret value once at process start (lazy-on-first-AiDraftService-use) and caches it in memory for the process lifetime. AWS-canonical pattern.

ECS/EKS task restart rebinds the secret; no application-level rotation handling needed at PR-5. M7 IaC adds automated rotation; consumer apps respect rotation by restart cadence (typically once-per-day or per-deploy).

**Rationale:** Per-request fetch wastes AWS API quota + adds latency. TTL refresh adds complexity for marginal benefit. Cache-at-start matches the production-grade-from-day-one posture per Charter Ruling C.

### Decision 5 — Audit-record persistence in new `ai_draft` Postgres schema + 12th lazy PrismaService

**Audit-event entity: `AiDraftEvent` append-only event log.** Mirrors M5 PR-2 `TalentEngagementEvent` precedent (single-row event log, intra-schema FK, whole-row immutability via BEFORE UPDATE trigger).

Event types: `request_built`, `request_sent`, `response_received`, `redaction_applied`, `error_raised`.

**Schema location: new `ai_draft` Postgres schema** owned by `libs/ai-draft`'s Prisma client. The 12th lazy PrismaService in the workspace.

**Why not the existing `audit` Postgres schema?** The `audit` schema is owned by `libs/consent`'s Prisma client (`ConsentAuditEvent`); two distinct Prisma clients pointing at the same Postgres schema creates ambiguous migration ownership. New `ai_draft` schema avoids the collision and matches the M5 PR-1 lib-per-domain pattern.

**Persisted fields per `AiDraftEvent` row:**
- `id` (UUID v7 primary key)
- `tenant_id` (UUID; tenant-scoped per Architecture §7.2)
- `event_type` (closed enum: 5 values above)
- `event_payload` (JSONB; per-type schema below)
- `created_at` (TIMESTAMPTZ NOT NULL)

**`event_payload` per type:**
- `request_built`: `{model, prompt_sha256, prompt_token_estimate, max_tokens, redacted_span_count_input}`.
- `request_sent`: `{model, retry_attempt, request_id}`.
- `response_received`: `{model_used, input_tokens, output_tokens, duration_ms, completion_sha256, redacted_span_count_output}`.
- `redaction_applied`: `{kind: 'pre_prompt' | 'post_completion', count, hashed_input_ref}`.
- `error_raised`: `{error_class, error_code, retry_attempt, hashed_input_ref}`.

**Forensic-recovery posture:** `AiDraftEvent` captures hashed references + token counts + redacted-span counts in DB. Full raw prompt/completion text is NOT persisted at PR-5; persistence of raw text is deferred to a future PR if forensic-recovery requirements escalate. CloudWatch logs (per ADR-0013) carry no raw text either — see Decision 7.

### Decision 6 — PII redaction at service layer; pre-prompt input + post-completion output

PR-5 ships `libs/ai-draft/src/lib/redaction.ts` — local util implementing:
- **Pre-prompt redaction:** SSN (US 9-digit + hyphenated), email addresses, phone numbers (US E.164 + 10-digit local), bank routing numbers, credit card numbers (Luhn-validated 13-19 digits).
- **Post-completion redaction:** same patterns (defense-in-depth; Anthropic models may reproduce PII the prompt contained).

Redaction is mandatory; no consumer-opt-out at PR-5. Configurable patterns can be added later if regulatory scope requires.

**Promotion path:** If a second consumer (M5 PR-6+ outreach surface, or M6/M7 consumers) needs redaction, the util promotes to `@aramo/common` (workspace-shared). Until then it lives in `libs/ai-draft/`.

**`redacted_span_count` reporting:** redaction returns `{redacted_text, span_count}`. `AiDraftEvent` records counts (not span contents).

### Decision 7 — Observability: sensitive-data hygiene; logs exclude raw prompts/completions

Per **ADR-0013 envelope discipline**, structured log emits include:
- `audit_record_id` (FK to `AiDraftEvent.id`).
- `sha256_input_hash` (SHA-256 of redacted prompt).
- `model_used`, token counts, duration.
- `redacted_span_count` (input + output).

Structured log emits **NEVER include:**
- Raw prompt text (pre or post redaction).
- Raw completion text (pre or post redaction).
- API key (Secrets Manager value).
- AWS credentials of any kind.

**Logger token pattern (per ADR-0013 Decision 6):** `AiDraftServiceLogger` via `useFactory: () => createAramoLogger(AiDraftService.name)`. PR-5 also provides `AiDraftRepositoryLogger` for the DB layer.

### Decision 8 — Model identifier hardcoded constant; re-bump via narrow housekeeping PR

Model identifier: `claude-opus-4-7` (per Anthropic docs at audit time; latest stable Claude Opus 4.X family).

Lives at `libs/ai-draft/src/lib/constants.ts`:

```typescript
export const ARAMO_AI_DRAFT_MODEL = 'claude-opus-4-7' as const;
```

Re-bumped via narrow housekeeping PRs (e.g., `HK-AI-DRAFT-MODEL-BUMP-claude-opus-4-8`) when Anthropic releases new model versions. Re-bump PR scope: constants.ts edit + integration test re-baseline + ADR-0015 revision-history note.

**NOT stored in Secrets Manager payload** alongside the API key — secret payload is the API key string only; model identifier is configuration, not credential.

### Decision 9 — Test substrate: interface-driven `DraftProvider` mock + `SecretCacheService` mock

PR-5 tests inject mock implementations of `DraftProvider` and `SecretCacheService` (or equivalent) via constructor DI. Mirrors `libs/consent` `IdempotencyService` DI-mockability precedent.

**Consequence:** No `aws-sdk-client-mock` devDep needed. No `vi.mock('@anthropic-ai/sdk')` module-level mock. No real AWS calls in tests. No real Anthropic calls in tests.

**Production wiring (`AiDraftModule.providers`):** real `AnthropicProvider` + real `SecretCacheService` (Anthropic SDK + AWS SDK consumption).

**Test wiring (per-test `Test.createTestingModule({...})`):** `.overrideProvider(DRAFT_PROVIDER_TOKEN).useValue(mockDraftProvider)` + same for secret cache.

### Decision 10 — Scope of AI consumption (added v1.1 at A8-3b, 2026-06-04)

**AI/LLM provider consumption is confined to `libs/ai-draft` and its declared consumers (per Decision 1).** New substrate surfaces — A8-2 import column-mapping, A8-3b résumé parse, and all future parse/inference surfaces — MUST use deterministic heuristics, NOT LLM calls. An LLM in any of these surfaces would be a NEW AI-consumption surface requiring an explicit ADR amendment (revision to Decision 10 with the new consumer's scope + audit posture).

**The structural enforcement is a per-lib `no-llm-boundary` spec** in each consumer-restricted lib's `src/tests/` directory. The spec walks all `.ts` files under the lib root and asserts none imports or names `@aramo/ai-draft`, `@anthropic-ai/sdk`, `DraftProvider`, or any standalone `llm`/`LLM`/`anthropic` identifier (comments are stripped before matching, so prose mentions of ADR-0015 do not trigger violations).

**At A8-3b the assertion logic was lifted to `@aramo/common` as `findNoLlmBoundaryViolations`** (libs/common/src/lib/testing/no-llm-boundary-assertion.ts) so all consumer specs share one source of truth — the two (A8-2 import + A8-3b resume-parse) and any future spec cannot drift on what "no LLM" structurally means.

**Currently in scope (no-LLM-required surfaces):**
- `libs/import` (A8-2) — column-mapping inference: deterministic header-synonym + data-shape sampling
- `libs/resume-parse` (A8-3b) — résumé text-extraction (pdf-parse / mammoth) + heuristic field-extraction (regex + structural section-matching)

**Rationale:** the AI substrate's value (drafted outreach text, candidate-fit synthesis) comes from open-ended generation. Parse/inference surfaces (column-mapping, résumé fields) have deterministic right answers; an LLM there trades verifiable correctness for opaque inference + new provider-cost surfaces + new PII exposure paths. The deterministic-heuristic posture is cheaper, faster, auditable, and explicitly bounded.

**Promotion path:** if a future PR genuinely needs LLM-assisted inference in one of these surfaces (e.g., column-mapping for free-text columns that defy synonym matching), the PR amends Decision 10 (revising the in-scope list + documenting the audit posture for the new consumer) BEFORE adding the wiring. The PR must NOT silently bypass the structural spec.

**Audit posture for any future LLM-extension:** the new consumer inherits Decisions 6 (PII redaction), 7 (no raw prompts/completions in logs), and the `AiDraftEvent` event-log (or an analogue scoped to its event types).

---

## §3. Consequences

**Positive:**
- AI substrate consumable from M5 PR-5 onward via stable `AiDraftService.generateDraft` interface.
- Provider swap mechanical (new adapter file + module token; no consumer-side changes).
- Forensic audit trail in `ai_draft.AiDraftEvent` event log.
- PII redaction defense-in-depth at service layer.
- Sensitive data never in CloudWatch logs.
- ADR-0012 Decision 7 not amended; bootstrap-outside-TF pattern reused per Decision 3 precedent.

**Negative:**
- 12th lazy PrismaService in workspace (substrate complexity grows by one).
- New `ai_draft` Postgres schema adds a migration directory to maintain.
- Bootstrap script is an out-of-Terraform operational artifact that must be run pre-Terraform per environment.
- Model-identifier re-bump requires housekeeping PR (not config-injected).

**Neutral:**
- Secret-name convention `aramo/<env>/anthropic-api-key` establishes the workspace's first AWS Secrets Manager naming standard; future secrets (M7 IaC formalization) inherit.
- `libs/audit` stays empty until a separate audit-substrate consumer needs it. The "audit" Postgres schema continues to be owned solely by `libs/consent`.

---

## §4. Revision history

| Version | Date | Author | Change |
|---|---|---|---|
| 1.0 | 2026-05-25 | Lead | Initial LOCK at M5 PR-5 substrate audit closure; 9 decisions; resolves Charter Ruling C × ADR-0012 Decision 7 sequencing tension via bootstrap-outside-TF. |
| 1.1 | 2026-06-04 | Lead | Added Decision 10 (Scope of AI consumption) at A8-3b — anchors the "AI isolated to ai-draft/drafts" posture that A8-2's no-llm-boundary spec (and now A8-3b's) cite. The code cited this ruling before the file stated it; v1.1 anchors it + names the structural spec helper lifted to `@aramo/common`. No change to the 9 v1.0 decisions; Decision 10 is additive. |
