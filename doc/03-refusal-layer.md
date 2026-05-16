# Aramo Refusal Layer

This document is the **most consequential** in the `doc/` folder. The refusal layer is what makes Aramo distinctive. It is the program's ethical and architectural commitments operationalized as code constraints.

A Claude Code instance asked to "add field X to surface Y" cannot tell whether the request violates a refusal commitment. This document tells you which surfaces are refusal-relevant and what the violations look like.

**Hard rule:** If a PR touches a refusal surface, the prompt MUST reference this document, and the Lead Engineer MUST verify refusal preservation before merge.

---

## What "Refusal" Means

A refusal is an architectural commitment that Aramo will not do something, even when it would be technically easy and seemingly helpful.

Refusals are operationalized as:

1. **Schema constraints** (e.g., `additionalProperties: false`, `const: false`, closed enums)
2. **Endpoint absence** (no API path exists for the refused operation)
3. **CI checks** (build fails if the refusal is violated)
4. **Code patterns** (specific patterns that preserve refusals, anti-patterns that violate them)

Each refusal is enforced through one or more of these mechanisms. **All four mechanisms must hold for the refusal to survive.** Removing any one creates a path to violation.

---

## The Thirteen Charter Refusals

From Charter Section 8. Each refusal is paired with its enforcement mechanism in this codebase.

### Scope Refusals

#### R1 — Aramo will not function as a job marketplace or job board

**Enforcement:**
- Portal API (`openapi/portal.yaml`) has no job listing, search, application, or marketplace endpoints
- No `JobListing` or `JobMarketplace` schemas exist anywhere

**Code anti-pattern (DO NOT DO):**
```typescript
// In portal API
@Get('/portal/jobs')
async listAvailableJobs() { ... }  // ❌ VIOLATES R1
```

**If asked to add this:** Refuse and escalate. This is a Charter-level commitment.

#### R2 — Aramo will not act as a sourcing engine as primary function

**Enforcement:**
- ATS API has no bulk-export endpoint
- ATS API has no free-form Talent search endpoint
- Constrained Talent access (Group 9) limits search to specific Talent retrieval and narrow manual-add

**Code anti-pattern:**
```typescript
@Get('/talents')
async searchAllTalents(@Query() filters: SearchFilters) { ... }  // ❌ VIOLATES R2

@Get('/talents/export')
async exportTalents() { ... }  // ❌ VIOLATES R2
```

**Allowed:**
```typescript
@Get('/talents/:talent_id')  // ✓ specific retrieval, recruiter-accessible
@Get('/jobs/:job_id/manual-add-search')  // ✓ narrow, job-scoped
```

#### R3 — Aramo will not provide candidate-facing job discovery or feeds

**Enforcement:**
- Portal API has no recommendation, feed, or discovery endpoints
- No `recommendations` or `feed` table or model exists

**Code anti-pattern:**
```typescript
@Get('/portal/recommendations')
async getRecommendedJobs() { ... }  // ❌ VIOLATES R3

@Get('/portal/feed')
async getActivityFeed() { ... }  // ❌ VIOLATES R3
```

---

### Behavior Refusals

#### R4 — Aramo will not infer consent from behavior

**Enforcement:**
- Consent module reads only `TalentConsentEvent` ledger
- No code path computes consent from behavior signals (response, click, opens)

**Code anti-pattern:**
```typescript
// In consent service
async checkConsent(talentId: string, scope: ConsentScope) {
  const lastResponse = await this.engagementRepo.getLastResponse(talentId);
  if (lastResponse?.respondedWithin30Days) {
    return { result: 'allowed' };  // ❌ VIOLATES R4 — inferring consent from behavior
  }
  ...
}
```

**Correct pattern:**
```typescript
async checkConsent(talentId: string, scope: ConsentScope) {
  const events = await this.consentRepo.getEvents(talentId, scope);
  return this.computeStateFromLedger(events);  // ✓ ledger-only
}
```

#### R5 — Aramo will not widen consent through aggregation of sources

**Enforcement:**
- Consent resolver applies *most restrictive applicable consent* across sources
- Per-tenant per-scope state is stored separately; never merged into a global view

**Code anti-pattern:**
```typescript
// Computing consent across multiple sources
const sources = await this.getSources(talentId);
const allowed = sources.some(s => s.contactingAllowed);  // ❌ VIOLATES R5 — using union (ANY)
```

**Correct pattern:**
```typescript
const allowed = sources.every(s => s.contactingAllowed);  // ✓ intersection (ALL)
```

The counterintuitive case from Group 2 v2.7 (Talent grants in Tenant B but Tenant A remains restricted) MUST be preserved. See `04-risks.md` for the worked example.

#### R6 — Aramo will not act on stale consent for high-impact actions

**Enforcement:**
- `is_stale` field on `ConsentScopeState` computed by daily background job
- Runtime consent check returns denied with `reason: stale_consent` for stale contacting consent
- Twelve-month threshold from Group 2 v2.7

**Code anti-pattern:**
```typescript
// Override stale consent for "important" outreach
if (isStale && isVipCandidate) {
  return { result: 'allowed' };  // ❌ VIOLATES R6
}
```

**Correct pattern:**
```typescript
if (isStale && scope === 'contacting') {
  return {
    result: 'denied',
    reason_code: 'stale_consent',
    display_message: 'Consent has expired. Refresh required.',
    log_message: `contacting_denied: stale_consent (last_active=${lastActive})`,
  };
}
```

#### R7 — Aramo will not perform automated LinkedIn scraping

**Enforcement (four-layer):**
1. `SourceType` enum closed to four values (`indeed`, `github`, `astre_import`, `talent_direct`)
2. `AdapterType` enum same; `x-prohibited-values: [linkedin, linkedin_scrape, linkedin_bulk, generic_web_scrape]` documented
3. No adapter registration endpoint exists
4. `SourcePolicyResponse.linkedin_automation_allowed: const: false`

**Code anti-pattern:**
```typescript
// Adding LinkedIn to the enum
enum SourceType {
  Indeed = 'indeed',
  GitHub = 'github',
  AstreImport = 'astre_import',
  TalentDirect = 'talent_direct',
  LinkedIn = 'linkedin',  // ❌ VIOLATES R7
}
```

**This is a Charter-level commitment.** Adding LinkedIn is outside Architect or Lead authority. It requires Charter-level approval per Section 8.

#### R8 — Aramo will not allow recruiter judgment to override system classification

**Enforcement:**
- `TalentJobExamination.tier` is set once at creation; immutable thereafter
- Override mechanism writes to separate `ExaminationOverride` entity
- `ExaminationOverrideResponse.examination_mutated: const: false`

**Code anti-pattern:**
```typescript
// Override endpoint mutating tier
@Post('/examinations/:id/overrides')
async createOverride(@Param('id') id: string, @Body() override: OverrideRequest) {
  if (override.override_type === 'tier') {
    await this.examRepo.update(id, { tier: override.proposed_value });  // ❌ VIOLATES R8
  }
  ...
}
```

**Correct pattern:**
```typescript
@Post('/examinations/:id/overrides')
async createOverride(@Param('id') id: string, @Body() override: OverrideRequest) {
  // Record override as separate entity; do NOT mutate Examination
  const record = await this.overrideRepo.create({
    examination_id: id,
    override_type: override.override_type,
    proposed_value: override.proposed_value,
    reason: override.reason,
  });
  return {
    ...record,
    examination_mutated: false,  // ✓ structurally guaranteed
  };
}
```

#### R9 — Aramo will not permit submission of Stretch-tier candidates

**Enforcement:**
- `POST /submittals` rejects Stretch with 422 `SUBMITTAL_STRETCH_BLOCKED`
- `POST /submittals/{id}/confirm` re-checks tier (Examination could in theory have changed; rare but possible)

**Code anti-pattern:**
```typescript
@Post('/submittals')
async createSubmittal(@Body() req: SubmittalCreateRequest) {
  // Blindly create submittal regardless of tier
  return this.submittalRepo.create(req);  // ❌ VIOLATES R9 if examination is Stretch
}
```

**Correct pattern:**
```typescript
@Post('/submittals')
async createSubmittal(@Body() req: SubmittalCreateRequest) {
  const examination = await this.examRepo.get(req.examination_id);
  if (examination.tier === 'STRETCH') {
    throw new BadRequestException({
      code: 'SUBMITTAL_STRETCH_BLOCKED',
      message: 'Stretch candidates cannot be submitted through Aramo.',
      display_message: 'This candidate does not meet Aramo\'s submission threshold.',
      log_message: `submittal_blocked: tier=STRETCH talent=${examination.talent_id}`,
    });
  }
  return this.submittalRepo.create(req);
}
```

#### R10 — Aramo will not expose internal reasoning or evaluation outputs to candidates

**Enforcement:**
- `openapi/portal.yaml` schemas use `additionalProperties: false`
- Portal response schemas have explicit `x-forbidden-fields` enumeration
- `verify-portal-refusal.ts` CI script fails build on any forbidden field presence

**Forbidden fields in any Portal response:**
```
tier, rank, rank_ordinal, score, examination_id,
why_matched_sentence, strengths, gaps, risk_flags,
recruiter_notes, override_id, action_queue_item_id,
internal_engagement_state
```

**Code anti-pattern:**
```typescript
// Portal endpoint that includes reasoning
@Get('/portal/engagements')
async getEngagements() {
  const engagements = await this.engagementRepo.list();
  return engagements.map(e => ({
    engagement_id: e.id,
    tenant_name: e.tenant.name,
    job_title: e.job.title,
    date_range: { started_at: e.startedAt, ended_at: e.endedAt },
    outcome: e.outcome,
    tier: e.examination.tier,  // ❌ VIOLATES R10 (forbidden field)
    why_matched: e.examination.whyMatchedSentence,  // ❌ VIOLATES R10
  }));
}
```

**Correct pattern:**
```typescript
@Get('/portal/engagements')
async getEngagements(): Promise<PortalEngagementSummary[]> {
  const engagements = await this.engagementRepo.list();
  return engagements.map(e => ({
    engagement_id: e.id,
    tenant_name: e.tenant.name,
    job_title: e.job.title,
    date_range: { started_at: e.startedAt, ended_at: e.endedAt },
    outcome: e.outcome,
    // ✓ exactly five fields; no examination data
  }));
}
```

---

### Posture Refusals

#### R11 — Aramo will not optimize engagement metrics over consent integrity

**Enforcement:**
- All engagement-related endpoints check consent before action
- No fast-path bypasses consent

**Code anti-pattern:**
```typescript
@Post('/engagements/:id/messages')
async sendMessage(@Param('id') id: string, @Body() msg: MessageRequest) {
  // Skip consent check for "high-priority" messages
  if (msg.priority === 'urgent') {
    return this.outboxService.send(msg);  // ❌ VIOLATES R11
  }
  await this.consentService.assertConsent(...);
  return this.outboxService.send(msg);
}
```

**Correct pattern:** Consent check happens unconditionally, before any send.

#### R12 — Aramo will not replace recruiter judgment with system autonomy

**Enforcement:**
- No automated submittal path exists
- `POST /submittals/{id}/confirm` requires recruiter attestations as `const: true`

**Code anti-pattern:**
```typescript
// Cron job that auto-submits high-confidence Entrustable candidates
@Cron('0 */6 * * *')
async autoSubmitEntrustables() {
  const candidates = await this.examRepo.findByConfidence('high');
  for (const c of candidates) {
    await this.submittalService.confirm(c.id);  // ❌ VIOLATES R12
  }
}
```

**This pattern must not exist.** Submission requires explicit recruiter action.

#### R13 — Aramo will not compromise consent integrity for engagement velocity

**Enforcement:**
- Consent check timeout returns `denied`, not `allowed-by-default`
- Stale consent blocks engagement regardless of business urgency

**Code anti-pattern:**
```typescript
async checkConsent(talentId: string, scope: ConsentScope) {
  try {
    return await this.consentClient.check(talentId, scope, { timeout: 500 });
  } catch (e) {
    if (e.name === 'TimeoutError') {
      return { result: 'allowed' };  // ❌ VIOLATES R13 — fail-open
    }
  }
}
```

**Correct pattern:**
```typescript
async checkConsent(talentId: string, scope: ConsentScope) {
  try {
    return await this.consentClient.check(talentId, scope, { timeout: 500 });
  } catch (e) {
    return {
      result: 'denied',
      reason_code: 'consent_state_unknown',
      log_message: `consent_check_failed: ${e.message}`,
    };  // ✓ fail-safe
  }
}
```

---

## Cross-Refusal Code Patterns

### Pattern: Closed enums must remain closed

When you see an enum with explicit values (no extensibility), do not add new values without explicit Architect approval.

**Closed enums in this program:**
- `ConsentScope` (5 values)
- `ContactChannel` (6 values)
- `ExaminationTier` (3 values)
- `EvidenceEntityType` (8 values)
- `SourceType` (4 values; LinkedIn variants are explicitly prohibited)
- `AdapterType` (4 values)
- `AstreImportSourceChannel` (5 values)
- `RecruiterNoteVisibility` (3 values)
- `EngagementState` (10 values per state machine)

### Pattern: `const: true` and `const: false` are non-negotiable

Several schemas use OpenAPI 3.1 `const` to make values non-negotiable:

- `RecruiterAttestations.candidate_evidence_reviewed: const: true`
- `RecruiterAttestations.constraints_reviewed: const: true`
- `RecruiterAttestations.submission_risk_acknowledged: const: true`
- `ExaminationOverrideResponse.examination_mutated: const: false`
- `SourcePolicyResponse.linkedin_automation_allowed: const: false`
- `SourcePolicyResponse.raw_payload_storage_required: const: true`
- `PortalRtbfConfirmRequest.confirmation_text: const: "DELETE MY DATA"`

**Removing `const` from any of these is a refusal violation.**

### Pattern: `additionalProperties: false` is universal

Every object schema in every OpenAPI file uses `additionalProperties: false`.

If you generate a schema without this constraint, the CI lint check will catch it. But Lead Engineers should verify it on every PR that adds schemas.

---

## When Refusal Conflicts With User Need

You will encounter situations where a refusal blocks something a user wants. Examples:

- "Can you let recruiters see scores so they understand ranking?" (Violates R10 if asked for Portal; violates "no raw scores" principle if asked for ATS)
- "Can we add LinkedIn ingestion just for one tenant?" (Violates R7)
- "The candidate wants to see why they weren't chosen, can we expose risk_flags in Portal?" (Violates R10)

**These conflicts are expected.** They are the visible manifestation of the program's commitments.

The correct response is **not** to find a workaround. The correct response is:

1. State the refusal clearly
2. Explain what need the refusal serves
3. Propose alternatives that don't violate the refusal (if any exist)
4. Escalate to PO/Architect if the user pushes back

If a Claude Code prompt asks for any of these, **stop and escalate.** Do not attempt to satisfy the request through clever code.

---

## Revision History

| Date | Change | By |
|---|---|---|
| 2026-04-27 | Initial seeding | Architect |
