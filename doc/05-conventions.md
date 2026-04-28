# Code Conventions

This document is the **canonical reference** for code-level patterns in the Aramo program. When implementing any feature, check this file for established patterns before inventing new ones.

If a pattern is not yet documented here, the first PR establishing the pattern updates this file.

---

## Stack (Locked from Architecture v2.0)

| Concern | Technology |
|---|---|
| Language | TypeScript (strict mode) |
| Runtime | Node.js LTS |
| Framework | NestJS |
| ORM | Prisma |
| Database | PostgreSQL 15+ (RDS) |
| Cache | Redis (ElastiCache) |
| Object storage | AWS S3 |
| Event bus | SNS + SQS |
| Internal jobs | BullMQ |
| Monorepo | Nx |
| API style | REST + OpenAPI 3.1 |
| Testing | Vitest + Testcontainers + Supertest + Playwright |
| Contract testing | Pact (`@pact-foundation/pact`) |

---

## Repository Structure (Aramo Core)

```
aramo-core/
├── apps/
│   └── api/                    # main API service
├── libs/
│   ├── consent/                # consent module
│   ├── talent/                 # talent module
│   ├── skills-taxonomy/        # skills module
│   ├── matching/               # matching module
│   ├── examination/            # examination module
│   ├── entrustability/         # entrustability module
│   ├── evidence/               # evidence package module
│   ├── engagement/             # engagement module
│   ├── audit/                  # audit module
│   ├── auth/                   # auth module
│   ├── events/                 # events module
│   └── common/                 # shared types and utilities
├── openapi/
│   ├── common.yaml
│   ├── ats.yaml
│   ├── portal.yaml
│   └── ingestion.yaml
├── ci/
│   ├── workflows/
│   └── scripts/
├── pact/
│   ├── consumers/
│   └── provider/
└── doc/
    └── (this folder)
```

**Module boundaries enforced via Nx `enforce-module-boundaries` lint rule.** Importing across module boundaries except via approved interfaces produces CI failure.

---

## Naming Conventions

### Files and Directories

- `kebab-case` for filenames: `consent.service.ts`, `examination.entity.ts`
- `kebab-case` for directories: `talent-graph/`, `evidence-package/`
- Test files: `*.spec.ts` (unit), `*.integration.spec.ts` (integration), `*.consumer.test.ts` (Pact)

### Code

- `camelCase` for variables, functions, methods
- `PascalCase` for classes, interfaces, types, enums
- `UPPER_SNAKE_CASE` for constants and enum values that are stable strings
- `snake_case` for database column names (Prisma maps to camelCase in TS)

### Domain Vocabulary (See `02-claude-code-discipline.md` Rule 5)

Always use:
- `talent_id`, `tenant_id`, `engagement_id`, `examination_id`
- `Talent`, `Examination`, `Engagement`, `Submittal`, `EvidencePackage`
- `Recruiter`, `Tenant`

Never use:
- `candidate`, `customer`, `account`, `user` (when referring to recruiters)

---

## Module Pattern

Every module follows this structure (consent module is the reference):

```
libs/consent/
├── src/
│   ├── lib/
│   │   ├── consent.module.ts          # NestJS module
│   │   ├── consent.controller.ts      # HTTP layer
│   │   ├── consent.service.ts         # business logic
│   │   ├── consent.resolver.ts        # state computation
│   │   ├── consent.repository.ts      # Prisma access
│   │   ├── consent.events.ts          # event emissions
│   │   ├── dto/                       # request/response DTOs
│   │   ├── entities/                  # Prisma model wrappers
│   │   └── types.ts                   # internal types
│   ├── tests/
│   │   ├── *.spec.ts                  # unit tests
│   │   └── *.integration.spec.ts      # integration tests
│   └── index.ts                       # public API
└── project.json                       # Nx config
```

**Public API rule:** Only types/services/exports listed in `index.ts` are accessible to other modules. Anything else is module-internal.

---

## Database Conventions (Prisma)

### Schema-per-Module

Each module owns a schema:

```prisma
// libs/consent/prisma/schema.prisma
model TalentConsentEvent {
  @@schema("consent")
  ...
}
```

Cross-schema references use UUID without FK:

```prisma
model TalentJobExamination {
  @@schema("examination")
  
  talent_id String  // UUID reference to talent.Talent; no FK constraint
  tenant_id String  // UUID
  
  ...
}
```

### Tenant ID Required

Every tenant-scoped table includes:

```prisma
model SomeEntity {
  tenant_id  String     @db.Uuid
  created_at DateTime   @default(now())
  updated_at DateTime   @updatedAt
  
  @@index([tenant_id, created_at])
}
```

The Talent core table is the only exception (tenant-agnostic identity).

### Append-Only Event Tables

```prisma
model TalentConsentEvent {
  id           String   @id @default(uuid()) @db.Uuid
  talent_id    String   @db.Uuid
  tenant_id    String   @db.Uuid
  scope        String   // ConsentScope enum value
  action       String   // 'granted' | 'revoked' | 'expired'
  occurred_at  DateTime @default(now())
  // No updated_at — events are immutable
  
  @@index([tenant_id, occurred_at])
  @@schema("consent")
}
```

---

## API Pattern (NestJS)

### Controller

```typescript
@Controller('consent')
export class ConsentController {
  constructor(private readonly consentService: ConsentService) {}
  
  @Post('check')
  @HttpCode(200)
  async check(
    @Body() body: ConsentCheckRequest,
    @CurrentTenant() tenantId: string,
    @CurrentActor() actor: Actor,
  ): Promise<ConsentDecision> {
    return this.consentService.check(tenantId, body, actor);
  }
}
```

### DTOs

DTOs are generated from OpenAPI schemas using `openapi-typescript-codegen` or maintained by hand to match. They live in `dto/` directory:

```typescript
// libs/consent/src/lib/dto/consent-check-request.dto.ts
import { IsUUID, IsEnum, IsOptional } from 'class-validator';

export class ConsentCheckRequest {
  @IsUUID()
  talent_id: string;
  
  @IsEnum(ConsentScope)
  scope: ConsentScope;
  
  @IsString()
  action: string;
  
  @IsOptional()
  @IsEnum(ContactChannel)
  channel?: ContactChannel;
}
```

### Service Pattern

```typescript
@Injectable()
export class ConsentService {
  constructor(
    private readonly repo: ConsentRepository,
    private readonly events: EventEmitter,
    private readonly logger: Logger,
  ) {}
  
  async check(
    tenantId: string,
    request: ConsentCheckRequest,
    actor: Actor,
  ): Promise<ConsentDecision> {
    // 1. Resolve current state from ledger
    const events = await this.repo.getEvents(tenantId, request.talent_id, request.scope);
    
    // 2. Apply staleness rule
    const isStale = this.isStale(events, request.scope);
    
    // 3. Apply channel constraint (if applicable)
    if (request.scope === 'contacting' && !request.channel) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', ... });
    }
    
    // 4. Compute decision
    const decision = this.computeDecision(events, isStale, request);
    
    // 5. Audit
    this.logger.log({ event: 'consent_check', decision_id: decision.decision_id, ... });
    
    return decision;
  }
}
```

---

## Error Handling Pattern

### Use the Locked Error Envelope

All errors return the standard envelope from `common.yaml`:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message",
    "details": {},
    "request_id": "uuid"
  }
}
```

### NestJS Implementation

```typescript
// Custom exception that produces the locked envelope
export class AramoException extends HttpException {
  constructor(
    statusCode: number,
    public readonly errorCode: string,
    message: string,
    public readonly details?: Record<string, any>,
    public readonly displayMessage?: string,
    public readonly logMessage?: string,
  ) {
    super(
      {
        error: {
          code: errorCode,
          message,
          display_message: displayMessage,
          log_message: logMessage,
          details: details ?? {},
          request_id: '__INJECTED__',  // filled by exception filter
        },
      },
      statusCode,
    );
  }
}

// Usage
throw new AramoException(
  422,
  'SUBMITTAL_STRETCH_BLOCKED',
  'Stretch candidates cannot be submitted through Aramo.',
  {},
  'This candidate does not meet Aramo\'s submission threshold.',
  `submittal_blocked: tier=STRETCH talent=${talentId}`,
);
```

### Anti-Patterns

```typescript
// ❌ Throwing strings
throw new Error('Stretch blocked');

// ❌ Generic HttpException without error code
throw new BadRequestException('Bad request');

// ❌ Custom envelope shape
return { success: false, error: 'BAD_TIER' };  // Doesn't match locked envelope
```

---

## Idempotency Pattern

### Required Header on Writes

```typescript
@Post('submittals')
async create(
  @Body() body: SubmittalCreateRequest,
  @Headers('idempotency-key') idempotencyKey: string,
): Promise<SubmittalResponse> {
  if (!idempotencyKey) {
    throw new AramoException(400, 'VALIDATION_ERROR', 'Idempotency-Key header required');
  }
  
  return this.submittalService.create(body, idempotencyKey);
}
```

### Service-Layer Implementation

```typescript
async create(request: SubmittalCreateRequest, idempotencyKey: string) {
  // Check for prior request with same key
  const existing = await this.idempotencyRepo.find(idempotencyKey);
  if (existing) {
    if (this.bodiesMatch(existing.requestBody, request)) {
      return existing.responseBody;  // Replay original response
    }
    throw new AramoException(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Key reused with different body');
  }
  
  // Process and store
  const response = await this.processCreate(request);
  await this.idempotencyRepo.store(idempotencyKey, request, response, { ttlHours: 24 });
  return response;
}
```

---

## Audit Pattern

### Every Consequential Operation Emits an Event

```typescript
async confirmSubmittal(submittalId: string, request: SubmittalConfirmRequest, actor: Actor) {
  // Business logic
  await this.submittalRepo.transitionToSubmitted(submittalId);
  
  // Audit event (within same transaction or via outbox)
  await this.eventEmitter.emit({
    event_type: 'submittal.confirmed',
    aggregate_type: 'TalentSubmittalRecord',
    aggregate_id: submittalId,
    tenant_id: request.tenant_id,
    actor_id: actor.id,
    occurred_at: new Date(),
    payload: { 
      examination_id: request.examination_id,
      tier: request.tier,
      attestations: request.attestations,
    },
  });
}
```

### Outbox Pattern for Cross-Service Events

```typescript
// Within transaction
await this.prisma.$transaction(async (tx) => {
  // 1. Domain write
  const submittal = await tx.submittalRecord.update(...);
  
  // 2. Outbox write (same transaction)
  await tx.outboxEvent.create({
    data: {
      event_type: 'submittal.handoff_completed',
      aggregate_id: submittal.id,
      payload: { ... },
      published: false,
    },
  });
});

// Outbox publisher (separate process) reads pending and emits to SNS
```

---

## Consent Check Pattern

### At Every Protected Action

```typescript
@Post('engagements')
async createEngagement(
  @Body() body: EngagementCreateRequest,
  @CurrentTenant() tenantId: string,
  @CurrentActor() actor: Actor,
) {
  // 1. Consent check (before any side effect)
  const consent = await this.consentService.check(tenantId, {
    talent_id: body.talent_id,
    scope: 'contacting',
    action: 'send_outreach',
    channel: body.channel,
  });
  
  if (consent.result !== 'allowed') {
    throw new AramoException(
      403,
      'CONSENT_DENIED',
      'Consent denied.',
      { consent_decision: consent },
    );
  }
  
  // 2. Proceed with engagement creation
  ...
}
```

**Anti-pattern:** Consent check after side effects, or "we'll check later," or "skip for high-priority."

---

## Pact Test Pattern

### Consumer Test Structure

```typescript
import { describe, it, expect } from 'vitest';
import { PactV3, MatchersV3 } from '@pact-foundation/pact';

const { like, uuid, integer } = MatchersV3;

describe('ATS - submittal confirm', () => {
  const provider = new PactV3({
    consumer: 'ats-thin',
    provider: 'aramo-core',
    dir: './pacts',
  });
  
  it('returns submittal_id and triggers handoff event', async () => {
    await provider
      .given('a Worth Considering examination exists with valid attestations')
      .uponReceiving('POST submittal confirm with valid attestations')
      .withRequest({
        method: 'POST',
        path: '/v1/submittals/00000000-0000-4000-8000-000000000001/confirm',
        headers: {
          Authorization: like('Bearer test-token'),
          'X-Request-ID': uuid(),
          'Idempotency-Key': like('confirm-1'),
          'Content-Type': 'application/json',
        },
        body: {
          attestations: {
            candidate_evidence_reviewed: true,
            constraints_reviewed: true,
            submission_risk_acknowledged: true,
          },
          justification_text: like('...'),
          failed_criteria_acknowledgments: [],
        },
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          submittal_id: uuid(),
          state: 'submitted_to_ats',
          evidence_package_id: uuid(),
        },
      })
      .executeTest(async (mockServer) => {
        const res = await fetch(`${mockServer.url}/v1/submittals/.../confirm`, {
          method: 'POST',
          headers: { ... },
          body: JSON.stringify({ ... }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.state).toBe('submitted_to_ats');
      });
  });
});
```

### Refusal-Verification Test Pattern

For refusal-relevant endpoints, write a test that verifies the refusal:

```typescript
it('blocks Stretch tier submittal', async () => {
  await provider
    .given('a Stretch-tier examination exists')
    .uponReceiving('POST create submittal for Stretch tier')
    .withRequest({ ... })
    .willRespondWith({
      status: 422,
      body: {
        error: {
          code: 'SUBMITTAL_STRETCH_BLOCKED',
          ...
        },
      },
    })
    .executeTest(async (mockServer) => {
      const res = await fetch(...);
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe('SUBMITTAL_STRETCH_BLOCKED');
    });
});
```

---

## Logging Pattern

### Structured Logging

Use NestJS `Logger` with structured context:

```typescript
this.logger.log({
  event: 'examination.created',
  examination_id: exam.id,
  talent_id: exam.talent_id,
  job_id: exam.job_id,
  tier: exam.tier,
  request_id: request.requestId,
});
```

### Sensitive Data

Never log:
- JWT tokens, API keys
- Resume content, document text
- Full contact details (email/phone)
- Consent text (log consent_event_id instead)

Always log:
- IDs (talent_id, examination_id, etc.)
- Decision codes (CONSENT_DENIED, SUBMITTAL_STRETCH_BLOCKED)
- request_id for trace correlation
- Actor (without PII)

---

## Test Coverage Targets

| Test type | Target |
|---|---|
| Unit tests | 80%+ on business logic |
| Integration tests | All API endpoints |
| Pact consumer tests | All cross-service endpoints |
| E2E tests | Critical user journeys (submittal flow, RTBF flow) |
| Refusal verification | All refusal-relevant code paths |

---

## What This File Is Not

- **Not a substitute for the locked specs.** Conventions here implement what the specs require; if conflict, specs win.
- **Not exhaustive.** Patterns emerge as construction proceeds. Update this file when new patterns stabilize.
- **Not for one-off decisions.** PR-specific decisions go in PR description; recurring patterns come here.

---

## Revision History

| Date | Change | By |
|---|---|---|
| 2026-04-27 | Initial seeding | Architect |
