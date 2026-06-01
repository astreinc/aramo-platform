import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError, type AramoLogger } from '@aramo/common';
import { ExaminationRepository } from '@aramo/examination';
import { JobDomainRepository } from '@aramo/job-domain';
import { recordUsage } from '@aramo/metering';
import { TalentRepository } from '@aramo/talent';

import { canTransition, type EngagementStateValue } from './engagement-state.js';
import type { EngagementEventTypeValue } from './engagement-event.js';
import type { EngagementConversationStartedPayload } from './dto/engagement-conversation-started-payload.js';
import type { EngagementResponseReceivedPayload } from './dto/engagement-response-received-payload.js';
import type { OutreachSentPayload } from './dto/outreach-sent-payload.js';
import type { TalentJobEngagementView } from './dto/talent-job-engagement.view.js';
import type { TalentEngagementEventView } from './dto/talent-engagement-event.view.js';
import { EngagementEventRepository } from './engagement-event.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// Repository for the TalentJobEngagement model (M5 PR-1 Directive v1.0
// §4.4 + M5 PR-3 Directive v1.0 §4.1 + Amendment v1.1 §2).
//
// Surface scope (closed):
//   PR-1 read methods (preserved verbatim):
//     - findById
//     - findByTenantAndId
//     - findByTenantAndTalent
//     - findByTenantAndRequisition
//   PR-3 write methods (new):
//     - createEngagement (3-pattern cross-schema validators + atomic txn)
//     - transitionState (canTransition guard + atomic txn)
//
// Write-method scope per Directive Ruling 2: createEngagement +
// transitionState are the ONLY write methods. NO general updateEngagement
// (rejected on column-scoped immutability principle — only the state
// column is mutable and only via transitionState's canTransition-guarded
// path; the DB-level trigger from M5 PR-1 enforces this regardless of
// repository surface).
//
// Three-pattern cross-schema validator design (Amendment v1.1 §2):
//   Pattern A (Requisition): findRequisitionById + app-layer tenant check.
//   Pattern B (Examination): findById + app-layer tenant check; nullable.
//   Pattern C (Talent): findOverlayByTenant + null-check (overlay-existence
//     proxy for tenant visibility — TalentDto is tenant-agnostic by
//     design; the overlay table is the tenant-visibility surface).
// All three validators run BEFORE prisma.$transaction opens (fail-fast).
// Validation order: talent_id → requisition_id → examination_id.
//
// Atomic transaction (Ruling 6): both write methods use prisma.$transaction
// to pair the TalentJobEngagement write with the TalentEngagementEvent
// audit-log row. Either both rows land or neither does.
//
// Tenant isolation (Architecture §7.2): three of the four read methods
// take tenant_id explicitly. `findById` is the exception (UUID lookup;
// tenant assertion is the caller's responsibility at the consumer site).
// All write methods enforce tenant scope via the Pattern A/B/C validators
// (createEngagement) or via findByTenantAndId (transitionState).
//
// Cross-schema read validation (Architecture §7.3 — UUID-only, no FK):
// `examination_id` and `requisition_id` are UUID-only references with
// no FK constraint. PR-3's validators provide the application-layer
// existence + tenant check at write time.
//
// Observability (Plan v1.5 §M4; HK-PR-4 adoption): Style A constructor-DI
// AramoLogger via 'EngagementRepositoryLogger'. Structured INFO-level
// logging at entry + hit/miss/result-count + validator-refusal + success
// paths.

interface TalentJobEngagementRow {
  id: string;
  tenant_id: string;
  talent_id: string;
  requisition_id: string;
  examination_id: string | null;
  state: EngagementStateValue;
  created_at: Date;
}

function projectView(row: TalentJobEngagementRow): TalentJobEngagementView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    talent_id: row.talent_id,
    requisition_id: row.requisition_id,
    examination_id: row.examination_id,
    state: row.state,
    created_at: row.created_at,
  };
}

// M5 PR-3 §4.1 — createEngagement input/output shapes.
export interface CreateEngagementInput {
  id: string;
  event_id: string;
  tenant_id: string;
  talent_id: string;
  requisition_id: string;
  examination_id?: string | null;
}

export interface CreateEngagementResult {
  engagement: TalentJobEngagementView;
  event: TalentEngagementEventView;
}

// M5 PR-3 §4.1 — transitionState input/output shapes.
export interface TransitionStateInput {
  engagement_id: string;
  event_id: string;
  tenant_id: string;
  to_state: EngagementStateValue;
}

export interface TransitionStateResult {
  engagement: TalentJobEngagementView;
  event: TalentEngagementEventView;
}

// M5 PR-6 §4.4 — sendOutreach input/output shapes (Ruling 1 Sub-Q1b).
//
// Single repository method paired with the EngagementController
// sendOutreach endpoint. Three-write atomic transaction:
//   1. engagement.update(state = 'awaiting_response')
//   2. talentEngagementEvent.create(event_type = 'outreach_sent', payload = OutreachSentPayload)
//   3. talentEngagementEvent.create(event_type = 'state_transition', payload = { from_state, to_state })
//
// Pre-transaction guards:
//   - findByTenantAndId(engagement_id, tenant_id) → null ⇒ NOT_FOUND 404.
//   - canTransition(current.state, 'awaiting_response') ⇒ false ⇒
//     ENGAGEMENT_STATE_INVALID 422.
//
// The transition target is hardcoded to 'awaiting_response' — the only
// legal next state for an 'engaged' engagement per the 11-state matrix
// (PR-1 Amendment v1.1 §4). Callers cannot pass a different to_state.
export interface SendOutreachInput {
  engagement_id: string;
  tenant_id: string;
  outreach_event_id: string;
  transition_event_id: string;
  outreach_payload: OutreachSentPayload;
}

export interface SendOutreachResult {
  engagement: TalentJobEngagementView;
  outreach_event: TalentEngagementEventView;
  transition_event: TalentEngagementEventView;
}

// M5 PR-7 §4.3 — recordResponse input/output shapes (Ruling 1).
//
// Single repository method paired with the EngagementController
// recordResponse endpoint. Three-write atomic transaction:
//   1. engagement.update(state = 'responded')
//   2. talentEngagementEvent.create(event_type = 'response_received',
//      payload = EngagementResponseReceivedPayload)
//   3. talentEngagementEvent.create(event_type = 'state_transition',
//      payload = { from_state, to_state })
//
// Pre-transaction guards (in order):
//   - findByTenantAndId(engagement_id, tenant_id) → null ⇒ NOT_FOUND 404.
//   - Cross-event reference validation (Ruling 4): the
//     response_payload.outreach_event_ref_id must resolve to an event
//     in the SAME tenant + SAME engagement + with event_type =
//     'outreach_sent'. Any of (null lookup / cross-engagement /
//     cross-tenant / wrong-event-type) ⇒
//     ENGAGEMENT_REFERENCE_NOT_FOUND 422.
//   - canTransition(current.state, 'responded') ⇒ false ⇒
//     ENGAGEMENT_STATE_INVALID 422. State-machine itself enforces
//     single-response semantics (engagement already in 'responded'
//     state cannot transition to 'responded' again — natural-key
//     dedup atop the standard Idempotency-Key replay path).
//
// The transition target is hardcoded to 'responded' — the only legal
// next state for an 'awaiting_response' engagement per the 11-state
// matrix (PR-1 Amendment v1.1 §4). Callers cannot pass a different
// to_state.
export interface RecordResponseInput {
  engagement_id: string;
  tenant_id: string;
  response_event_id: string;
  transition_event_id: string;
  response_payload: EngagementResponseReceivedPayload;
}

export interface RecordResponseResult {
  engagement: TalentJobEngagementView;
  response_event: TalentEngagementEventView;
  transition_event: TalentEngagementEventView;
}

// M5 PR-8a §4.3 — recordConversationStarted input/output shapes (Ruling 1 + 5).
//
// Single repository method paired with the EngagementController
// recordConversationStarted endpoint. Three-write atomic transaction:
//   1. engagement.update(state = 'in_conversation')
//   2. talentEngagementEvent.create(event_type = 'conversation_started',
//      payload = EngagementConversationStartedPayload)
//   3. talentEngagementEvent.create(event_type = 'state_transition',
//      payload = { from_state, to_state })
//
// Pre-transaction guards (in order; SIMPLER than PR-7 — no cross-event
// reference validation per Ruling 3):
//   - findByTenantAndId(engagement_id, tenant_id) → null ⇒ NOT_FOUND 404.
//   - canTransition(current.state, 'in_conversation') ⇒ false ⇒
//     ENGAGEMENT_STATE_INVALID 422. State-machine itself enforces
//     single-conversation semantics: an engagement already in
//     'in_conversation' state cannot transition to 'in_conversation'
//     again (natural-key dedup atop the standard Idempotency-Key replay
//     path); an engagement in 'engaged' or 'awaiting_response' cannot
//     skip the 'responded' step.
//
// The transition target is hardcoded to 'in_conversation' — the only
// legal next state for a 'responded' engagement per the 11-state matrix
// (PR-1 Amendment v1.1 §4). Callers cannot pass a different to_state.
export interface RecordConversationStartedInput {
  engagement_id: string;
  tenant_id: string;
  conversation_event_id: string;
  transition_event_id: string;
  conversation_payload: EngagementConversationStartedPayload;
}

export interface RecordConversationStartedResult {
  engagement: TalentJobEngagementView;
  conversation_event: TalentEngagementEventView;
  transition_event: TalentEngagementEventView;
}

interface TalentEngagementEventRow {
  id: string;
  tenant_id: string;
  engagement_id: string;
  event_type: EngagementEventTypeValue;
  event_payload: unknown;
  created_at: Date;
}

function projectEventView(row: TalentEngagementEventRow): TalentEngagementEventView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    engagement_id: row.engagement_id,
    event_type: row.event_type,
    event_payload: row.event_payload,
    created_at: row.created_at,
  };
}

@Injectable()
export class EngagementRepository {
  constructor(
    private readonly prisma: PrismaService,
    // M5 PR-3 — EngagementEventRepository unused here directly (the atomic
    // transaction issues prisma.talentEngagementEvent.create inline), but
    // retained in the constructor for module-graph clarity and future
    // M5 PR-5/6/7 consumers that may delegate event-append to the
    // dedicated repository.
    private readonly engagementEventRepository: EngagementEventRepository,
    // M5 PR-3 — Pattern C (Talent) cross-schema validator dep.
    private readonly talentRepository: TalentRepository,
    // M5 PR-3 — Pattern A (Requisition) cross-schema validator dep.
    private readonly jobDomainRepository: JobDomainRepository,
    // M5 PR-3 — Pattern B (Examination) cross-schema validator dep.
    private readonly examinationRepository: ExaminationRepository,
    @Inject('EngagementRepositoryLogger')
    private readonly logger: AramoLogger,
  ) {}

  // ---- Read methods (M5 PR-1; preserved verbatim) -----------------------

  async findById(id: string): Promise<TalentJobEngagementView | null> {
    const startedAt = Date.now();
    const row = await this.prisma.talentJobEngagement.findUnique({
      where: { id },
    });
    const view = row === null ? null : projectView(row as TalentJobEngagementRow);
    this.logger.log({
      event: 'engagement.findById',
      engagement_id: id,
      hit: view !== null,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }

  async findByTenantAndId(input: {
    tenant_id: string;
    id: string;
  }): Promise<TalentJobEngagementView | null> {
    const startedAt = Date.now();
    const row = await this.prisma.talentJobEngagement.findFirst({
      where: { tenant_id: input.tenant_id, id: input.id },
    });
    const view = row === null ? null : projectView(row as TalentJobEngagementRow);
    this.logger.log({
      event: 'engagement.findByTenantAndId',
      tenant_id: input.tenant_id,
      engagement_id: input.id,
      hit: view !== null,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }

  async findByTenantAndTalent(input: {
    tenant_id: string;
    talent_id: string;
  }): Promise<TalentJobEngagementView[]> {
    const startedAt = Date.now();
    const rows = await this.prisma.talentJobEngagement.findMany({
      where: { tenant_id: input.tenant_id, talent_id: input.talent_id },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    const views = (rows as TalentJobEngagementRow[]).map((r) => projectView(r));
    this.logger.log({
      event: 'engagement.findByTenantAndTalent',
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      result_count: views.length,
      latency_ms: Date.now() - startedAt,
    });
    return views;
  }

  async findByTenantAndRequisition(input: {
    tenant_id: string;
    requisition_id: string;
  }): Promise<TalentJobEngagementView[]> {
    const startedAt = Date.now();
    const rows = await this.prisma.talentJobEngagement.findMany({
      where: {
        tenant_id: input.tenant_id,
        requisition_id: input.requisition_id,
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    const views = (rows as TalentJobEngagementRow[]).map((r) => projectView(r));
    this.logger.log({
      event: 'engagement.findByTenantAndRequisition',
      tenant_id: input.tenant_id,
      requisition_id: input.requisition_id,
      result_count: views.length,
      latency_ms: Date.now() - startedAt,
    });
    return views;
  }

  // ---- Write methods (M5 PR-3) -----------------------------------------

  // createEngagement — Directive v1.0 §4.1 + Amendment v1.1 §2.
  // 5-step flow: input-validation → 3 cross-schema validators →
  // atomic prisma.$transaction(engagement.create + event.create) →
  // project + return → structured logging.
  async createEngagement(input: CreateEngagementInput): Promise<CreateEngagementResult> {
    const startedAt = Date.now();
    this.logger.log({
      event: 'engagement.create_started',
      tenant_id: input.tenant_id,
      engagement_id: input.id,
      talent_id: input.talent_id,
      requisition_id: input.requisition_id,
      examination_id: input.examination_id ?? null,
    });

    // ---- Step 1: input validation -------------------------------------
    this.validateCreateInput(input);

    // ---- Step 2a: Pattern C — Talent (overlay-existence) --------------
    const overlay = await this.talentRepository.findOverlayByTenant({
      talent_id: input.talent_id,
      tenant_id: input.tenant_id,
    });
    if (overlay === null) {
      this.logRefused('ENGAGEMENT_REFERENCE_NOT_FOUND', input, 'talent_id');
      throw new AramoError(
        'ENGAGEMENT_REFERENCE_NOT_FOUND',
        'Talent not visible in tenant',
        422,
        {
          requestId: 'engagement-create',
          details: { field: 'talent_id', talent_id: input.talent_id, tenant_id: input.tenant_id },
        },
      );
    }

    // ---- Step 2b: Pattern A — Requisition (app-layer tenant check) ----
    const requisition = await this.jobDomainRepository.findRequisitionById(input.requisition_id);
    if (requisition === null || requisition.tenant_id !== input.tenant_id) {
      this.logRefused('ENGAGEMENT_REFERENCE_NOT_FOUND', input, 'requisition_id');
      throw new AramoError(
        'ENGAGEMENT_REFERENCE_NOT_FOUND',
        'Requisition not found or not visible in tenant',
        422,
        {
          requestId: 'engagement-create',
          details: { field: 'requisition_id', requisition_id: input.requisition_id, tenant_id: input.tenant_id },
        },
      );
    }

    // ---- Step 2c: Pattern B — Examination (nullable; app-layer tenant) -
    if (input.examination_id !== undefined && input.examination_id !== null) {
      const examination = await this.examinationRepository.findById(input.examination_id);
      if (examination === null || examination.tenant_id !== input.tenant_id) {
        this.logRefused('ENGAGEMENT_REFERENCE_NOT_FOUND', input, 'examination_id');
        throw new AramoError(
          'ENGAGEMENT_REFERENCE_NOT_FOUND',
          'TalentJobExamination not found or not visible in tenant',
          422,
          {
            requestId: 'engagement-create',
            details: { field: 'examination_id', examination_id: input.examination_id, tenant_id: input.tenant_id },
          },
        );
      }
    }

    // ---- Step 3: atomic transaction (engagement.create + event.create
    // + outbox.create) — M6 PR-2 §3 adds the in-tx outbox emission;
    // rollback leaves no orphan outbox row (Cat 5 proof).
    // Initial state hardcoded to 'surfaced' per Ruling 3 (matching engine
    // creates the row in surfaced; the from_state on the initial event
    // is null because there is no prior state).
    const [engagementRow, eventRow] = await this.prisma.$transaction([
      this.prisma.talentJobEngagement.create({
        data: {
          id: input.id,
          tenant_id: input.tenant_id,
          talent_id: input.talent_id,
          requisition_id: input.requisition_id,
          examination_id: input.examination_id ?? null,
          state: 'surfaced',
        },
      }),
      this.prisma.talentEngagementEvent.create({
        data: {
          id: input.event_id,
          tenant_id: input.tenant_id,
          engagement_id: input.id,
          event_type: 'state_transition',
          event_payload: { from_state: null, to_state: 'surfaced' } as never,
        },
      }),
      this.prisma.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: 'engagement.state_transition',
          event_payload: {
            engagement_id: input.id,
            tenant_id: input.tenant_id,
            from_state: null,
            to_state: 'surfaced',
            transition_event_id: input.event_id,
          } as never,
        },
      }),
      // PR-A1c — in-tx metered usage event. Same $transaction array =
      // same PG transaction = atomicity with the domain write (Ruling 6).
      recordUsage(this.prisma, {
        tenant_id: input.tenant_id,
        event_type: 'engagement.state_transition',
      }),
    ]);

    // ---- Step 4 + 5: project + return + success log -------------------
    const result: CreateEngagementResult = {
      engagement: projectView(engagementRow as TalentJobEngagementRow),
      event: projectEventView(eventRow as TalentEngagementEventRow),
    };
    this.logger.log({
      event: 'engagement.created',
      tenant_id: result.engagement.tenant_id,
      engagement_id: result.engagement.id,
      engagement_event_id: result.event.id,
      initial_state: result.engagement.state,
      latency_ms: Date.now() - startedAt,
    });
    return result;
  }

  // transitionState — Directive v1.0 §4.1 + Ruling 5.
  // Read current → canTransition guard → atomic update + event append.
  async transitionState(input: TransitionStateInput): Promise<TransitionStateResult> {
    const startedAt = Date.now();
    this.logger.log({
      event: 'engagement.transition_started',
      tenant_id: input.tenant_id,
      engagement_id: input.engagement_id,
      to_state: input.to_state,
    });

    // ---- Step 1: read current engagement (tenant-scoped) --------------
    const current = await this.findByTenantAndId({
      tenant_id: input.tenant_id,
      id: input.engagement_id,
    });
    if (current === null) {
      this.logger.log({
        event: 'engagement.transition_refused',
        error_code: 'NOT_FOUND',
        tenant_id: input.tenant_id,
        engagement_id: input.engagement_id,
      });
      throw new AramoError(
        'NOT_FOUND',
        'TalentJobEngagement not found',
        404,
        {
          requestId: 'engagement-transition',
          details: { engagement_id: input.engagement_id, tenant_id: input.tenant_id },
        },
      );
    }

    // ---- Step 2: canTransition guard -----------------------------------
    if (!canTransition(current.state, input.to_state)) {
      this.logger.log({
        event: 'engagement.transition_refused',
        error_code: 'ENGAGEMENT_STATE_INVALID',
        tenant_id: input.tenant_id,
        engagement_id: input.engagement_id,
        from_state: current.state,
        to_state: input.to_state,
      });
      throw new AramoError(
        'ENGAGEMENT_STATE_INVALID',
        `Illegal engagement state transition: ${current.state} -> ${input.to_state}`,
        422,
        {
          requestId: 'engagement-transition',
          details: {
            engagement_id: input.engagement_id,
            from_state: current.state,
            to_state: input.to_state,
          },
        },
      );
    }

    // ---- Step 3: atomic transaction (engagement.update + event.create
    // + outbox.create) — M6 PR-2 §3 in-tx outbox emission.
    const [updatedRow, eventRow] = await this.prisma.$transaction([
      this.prisma.talentJobEngagement.update({
        where: { id: input.engagement_id },
        data: { state: input.to_state },
      }),
      this.prisma.talentEngagementEvent.create({
        data: {
          id: input.event_id,
          tenant_id: input.tenant_id,
          engagement_id: input.engagement_id,
          event_type: 'state_transition',
          event_payload: {
            from_state: current.state,
            to_state: input.to_state,
          } as never,
        },
      }),
      this.prisma.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: 'engagement.state_transition',
          event_payload: {
            engagement_id: input.engagement_id,
            tenant_id: input.tenant_id,
            from_state: current.state,
            to_state: input.to_state,
            transition_event_id: input.event_id,
          } as never,
        },
      }),
      // PR-A1c — in-tx metered usage event (Ruling 6 same-transaction).
      recordUsage(this.prisma, {
        tenant_id: input.tenant_id,
        event_type: 'engagement.state_transition',
      }),
    ]);

    // ---- Step 4 + 5: project + return + success log -------------------
    const result: TransitionStateResult = {
      engagement: projectView(updatedRow as TalentJobEngagementRow),
      event: projectEventView(eventRow as TalentEngagementEventRow),
    };
    this.logger.log({
      event: 'engagement.transitioned',
      tenant_id: result.engagement.tenant_id,
      engagement_id: result.engagement.id,
      engagement_event_id: result.event.id,
      from_state: current.state,
      to_state: result.engagement.state,
      latency_ms: Date.now() - startedAt,
    });
    return result;
  }

  // sendOutreach — M5 PR-6 Directive v1.0 §4.4 + Ruling 1 Sub-Q1b.
  // Read current → NOT_FOUND guard → canTransition(engaged →
  // awaiting_response) guard → atomic 3-write transaction (engagement
  // update + outreach_sent event + state_transition event). Mirrors the
  // transitionState fail-fast pattern: AI/delivery side-effects occur in
  // the controller BEFORE this method is called, so a pre-transaction
  // failure (AI provider, delivery) leaves engagement state + event log
  // unchanged (no partial-state observability).
  async sendOutreach(input: SendOutreachInput): Promise<SendOutreachResult> {
    const startedAt = Date.now();
    this.logger.log({
      event: 'engagement.outreach_started',
      tenant_id: input.tenant_id,
      engagement_id: input.engagement_id,
      outreach_event_id: input.outreach_event_id,
      transition_event_id: input.transition_event_id,
    });

    // ---- Step 1: read current engagement (tenant-scoped) --------------
    const current = await this.findByTenantAndId({
      tenant_id: input.tenant_id,
      id: input.engagement_id,
    });
    if (current === null) {
      this.logger.log({
        event: 'engagement.outreach_refused',
        error_code: 'NOT_FOUND',
        tenant_id: input.tenant_id,
        engagement_id: input.engagement_id,
      });
      throw new AramoError(
        'NOT_FOUND',
        'TalentJobEngagement not found',
        404,
        {
          requestId: 'engagement-outreach',
          details: { engagement_id: input.engagement_id, tenant_id: input.tenant_id },
        },
      );
    }

    // ---- Step 2: canTransition guard (engaged → awaiting_response) ----
    const TO_STATE: EngagementStateValue = 'awaiting_response';
    if (!canTransition(current.state, TO_STATE)) {
      this.logger.log({
        event: 'engagement.outreach_refused',
        error_code: 'ENGAGEMENT_STATE_INVALID',
        tenant_id: input.tenant_id,
        engagement_id: input.engagement_id,
        from_state: current.state,
        to_state: TO_STATE,
      });
      throw new AramoError(
        'ENGAGEMENT_STATE_INVALID',
        `Illegal engagement state transition: ${current.state} -> ${TO_STATE}`,
        422,
        {
          requestId: 'engagement-outreach',
          details: {
            engagement_id: input.engagement_id,
            from_state: current.state,
            to_state: TO_STATE,
          },
        },
      );
    }

    // ---- Step 3: atomic 4-write transaction (update + outreach_sent +
    // state_transition + outbox) — M6 PR-2 §3 in-tx outbox emission;
    // one outbox row per state_transition (Amendment §2.3).
    const [updatedRow, outreachEventRow, transitionEventRow] =
      await this.prisma.$transaction([
        this.prisma.talentJobEngagement.update({
          where: { id: input.engagement_id },
          data: { state: TO_STATE },
        }),
        this.prisma.talentEngagementEvent.create({
          data: {
            id: input.outreach_event_id,
            tenant_id: input.tenant_id,
            engagement_id: input.engagement_id,
            event_type: 'outreach_sent',
            event_payload: input.outreach_payload as never,
          },
        }),
        this.prisma.talentEngagementEvent.create({
          data: {
            id: input.transition_event_id,
            tenant_id: input.tenant_id,
            engagement_id: input.engagement_id,
            event_type: 'state_transition',
            event_payload: {
              from_state: current.state,
              to_state: TO_STATE,
            } as never,
          },
        }),
        this.prisma.outboxEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            event_type: 'engagement.state_transition',
            event_payload: {
              engagement_id: input.engagement_id,
              tenant_id: input.tenant_id,
              from_state: current.state,
              to_state: TO_STATE,
              transition_event_id: input.transition_event_id,
            } as never,
          },
        }),
        // PR-A1c — in-tx metered usage event (Ruling 6 same-transaction).
        recordUsage(this.prisma, {
          tenant_id: input.tenant_id,
          event_type: 'engagement.state_transition',
        }),
      ]);

    // ---- Step 4 + 5: project + return + success log ------------------
    const result: SendOutreachResult = {
      engagement: projectView(updatedRow as TalentJobEngagementRow),
      outreach_event: projectEventView(outreachEventRow as TalentEngagementEventRow),
      transition_event: projectEventView(transitionEventRow as TalentEngagementEventRow),
    };
    this.logger.log({
      event: 'engagement.outreach_sent',
      tenant_id: result.engagement.tenant_id,
      engagement_id: result.engagement.id,
      outreach_event_id: result.outreach_event.id,
      transition_event_id: result.transition_event.id,
      from_state: current.state,
      to_state: result.engagement.state,
      latency_ms: Date.now() - startedAt,
    });
    return result;
  }

  // recordResponse — M5 PR-7 Directive v1.0 §4.3 + Rulings 1, 2, 4, 5.
  // Read current → NOT_FOUND guard → cross-event-ref validation (Ruling
  // 4) → canTransition(awaiting_response → responded) guard → atomic
  // 3-write transaction (engagement update + response_received event +
  // state_transition event). All refusals leave engagement state +
  // event log unchanged (pre-transaction failure semantics).
  async recordResponse(input: RecordResponseInput): Promise<RecordResponseResult> {
    const startedAt = Date.now();
    this.logger.log({
      event: 'engagement.response_recording_started',
      tenant_id: input.tenant_id,
      engagement_id: input.engagement_id,
      response_event_id: input.response_event_id,
      transition_event_id: input.transition_event_id,
      outreach_event_ref_id: input.response_payload.outreach_event_ref_id,
    });

    // ---- Step 1: read current engagement (tenant-scoped) --------------
    const current = await this.findByTenantAndId({
      tenant_id: input.tenant_id,
      id: input.engagement_id,
    });
    if (current === null) {
      this.logger.log({
        event: 'engagement.response_recording_refused',
        error_code: 'NOT_FOUND',
        tenant_id: input.tenant_id,
        engagement_id: input.engagement_id,
      });
      throw new AramoError(
        'NOT_FOUND',
        'TalentJobEngagement not found',
        404,
        {
          requestId: 'engagement-record-response',
          details: { engagement_id: input.engagement_id, tenant_id: input.tenant_id },
        },
      );
    }

    // ---- Step 2: cross-event reference validation (Ruling 4) ----------
    // The referenced event must:
    //   (a) exist (findByTenantAndId returns non-null), which also
    //       enforces tenant scope — cross-tenant attack returns null.
    //   (b) live on the SAME engagement_id (defends against
    //       cross-engagement pollution within the same tenant).
    //   (c) have event_type='outreach_sent' (defends against pointing
    //       at a sibling state_transition or future event type).
    const refEvent = await this.engagementEventRepository.findByTenantAndId({
      tenant_id: input.tenant_id,
      id: input.response_payload.outreach_event_ref_id,
    });
    if (
      refEvent === null ||
      refEvent.engagement_id !== input.engagement_id ||
      refEvent.event_type !== 'outreach_sent'
    ) {
      this.logger.log({
        event: 'engagement.response_recording_refused',
        error_code: 'ENGAGEMENT_REFERENCE_NOT_FOUND',
        tenant_id: input.tenant_id,
        engagement_id: input.engagement_id,
        outreach_event_ref_id: input.response_payload.outreach_event_ref_id,
        ref_resolved: refEvent !== null,
        ref_engagement_match: refEvent !== null && refEvent.engagement_id === input.engagement_id,
        ref_event_type: refEvent?.event_type ?? null,
      });
      throw new AramoError(
        'ENGAGEMENT_REFERENCE_NOT_FOUND',
        'outreach_event_ref_id not found, not in tenant, or not an outreach_sent event',
        422,
        {
          requestId: 'engagement-record-response',
          details: {
            field: 'outreach_event_ref_id',
            outreach_event_ref_id: input.response_payload.outreach_event_ref_id,
            engagement_id: input.engagement_id,
            tenant_id: input.tenant_id,
          },
        },
      );
    }

    // ---- Step 3: canTransition guard (awaiting_response → responded) -
    const TO_STATE: EngagementStateValue = 'responded';
    if (!canTransition(current.state, TO_STATE)) {
      this.logger.log({
        event: 'engagement.response_recording_refused',
        error_code: 'ENGAGEMENT_STATE_INVALID',
        tenant_id: input.tenant_id,
        engagement_id: input.engagement_id,
        from_state: current.state,
        to_state: TO_STATE,
      });
      throw new AramoError(
        'ENGAGEMENT_STATE_INVALID',
        `Illegal engagement state transition: ${current.state} -> ${TO_STATE}`,
        422,
        {
          requestId: 'engagement-record-response',
          details: {
            engagement_id: input.engagement_id,
            from_state: current.state,
            to_state: TO_STATE,
          },
        },
      );
    }

    // ---- Step 4: atomic 4-write transaction (update + response_received
    // + state_transition + outbox) — M6 PR-2 §3 in-tx outbox emission.
    const [updatedRow, responseEventRow, transitionEventRow] =
      await this.prisma.$transaction([
        this.prisma.talentJobEngagement.update({
          where: { id: input.engagement_id },
          data: { state: TO_STATE },
        }),
        this.prisma.talentEngagementEvent.create({
          data: {
            id: input.response_event_id,
            tenant_id: input.tenant_id,
            engagement_id: input.engagement_id,
            event_type: 'response_received',
            event_payload: input.response_payload as never,
          },
        }),
        this.prisma.talentEngagementEvent.create({
          data: {
            id: input.transition_event_id,
            tenant_id: input.tenant_id,
            engagement_id: input.engagement_id,
            event_type: 'state_transition',
            event_payload: {
              from_state: current.state,
              to_state: TO_STATE,
            } as never,
          },
        }),
        this.prisma.outboxEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            event_type: 'engagement.state_transition',
            event_payload: {
              engagement_id: input.engagement_id,
              tenant_id: input.tenant_id,
              from_state: current.state,
              to_state: TO_STATE,
              transition_event_id: input.transition_event_id,
            } as never,
          },
        }),
        // PR-A1c — in-tx metered usage event (Ruling 6 same-transaction).
        recordUsage(this.prisma, {
          tenant_id: input.tenant_id,
          event_type: 'engagement.state_transition',
        }),
      ]);

    // ---- Step 5 + 6: project + return + success log ------------------
    const result: RecordResponseResult = {
      engagement: projectView(updatedRow as TalentJobEngagementRow),
      response_event: projectEventView(responseEventRow as TalentEngagementEventRow),
      transition_event: projectEventView(transitionEventRow as TalentEngagementEventRow),
    };
    this.logger.log({
      event: 'engagement.response_recorded',
      tenant_id: result.engagement.tenant_id,
      engagement_id: result.engagement.id,
      response_event_id: result.response_event.id,
      transition_event_id: result.transition_event.id,
      outreach_event_ref_id: input.response_payload.outreach_event_ref_id,
      from_state: current.state,
      to_state: result.engagement.state,
      latency_ms: Date.now() - startedAt,
    });
    return result;
  }

  // recordConversationStarted — M5 PR-8a Directive v1.0 §4.3 + Rulings
  // 1, 2, 3, 5. Read current → NOT_FOUND guard → canTransition(responded
  // → in_conversation) guard → atomic 3-write transaction (engagement
  // update + conversation_started event + state_transition event).
  //
  // SIMPLER than PR-7 recordResponse (5 internal steps vs PR-7's 6):
  // NO cross-event reference validation (Ruling 3 — workflow invariant
  // is sufficiently enforced by canTransition; the prior
  // response_received event is implicit and not explicitly referenced
  // in the conversation_started payload).
  //
  // All refusals leave engagement state + event log unchanged (pre-
  // transaction failure semantics).
  async recordConversationStarted(
    input: RecordConversationStartedInput,
  ): Promise<RecordConversationStartedResult> {
    const startedAt = Date.now();
    this.logger.log({
      event: 'engagement.conversation_started_recording_started',
      tenant_id: input.tenant_id,
      engagement_id: input.engagement_id,
      conversation_event_id: input.conversation_event_id,
      transition_event_id: input.transition_event_id,
      conversation_started_at: input.conversation_payload.conversation_started_at,
    });

    // ---- Step 1: read current engagement (tenant-scoped) --------------
    const current = await this.findByTenantAndId({
      tenant_id: input.tenant_id,
      id: input.engagement_id,
    });
    if (current === null) {
      this.logger.log({
        event: 'engagement.conversation_started_recording_refused',
        error_code: 'NOT_FOUND',
        tenant_id: input.tenant_id,
        engagement_id: input.engagement_id,
      });
      throw new AramoError(
        'NOT_FOUND',
        'TalentJobEngagement not found',
        404,
        {
          requestId: 'engagement-record-conversation-started',
          details: { engagement_id: input.engagement_id, tenant_id: input.tenant_id },
        },
      );
    }

    // ---- Step 2: canTransition guard (responded → in_conversation) ----
    // Also handles natural-key dedup: an engagement already in
    // 'in_conversation' cannot transition to 'in_conversation' again
    // (canTransition returns false because the matrix has no self-loop).
    const TO_STATE: EngagementStateValue = 'in_conversation';
    if (!canTransition(current.state, TO_STATE)) {
      this.logger.log({
        event: 'engagement.conversation_started_recording_refused',
        error_code: 'ENGAGEMENT_STATE_INVALID',
        tenant_id: input.tenant_id,
        engagement_id: input.engagement_id,
        from_state: current.state,
        to_state: TO_STATE,
      });
      throw new AramoError(
        'ENGAGEMENT_STATE_INVALID',
        `Illegal engagement state transition: ${current.state} -> ${TO_STATE}`,
        422,
        {
          requestId: 'engagement-record-conversation-started',
          details: {
            engagement_id: input.engagement_id,
            from_state: current.state,
            to_state: TO_STATE,
          },
        },
      );
    }

    // ---- Step 3: atomic 4-write transaction (update + conversation_started
    // + state_transition + outbox) — M6 PR-2 §3 in-tx outbox emission.
    const [updatedRow, conversationEventRow, transitionEventRow] =
      await this.prisma.$transaction([
        this.prisma.talentJobEngagement.update({
          where: { id: input.engagement_id },
          data: { state: TO_STATE },
        }),
        this.prisma.talentEngagementEvent.create({
          data: {
            id: input.conversation_event_id,
            tenant_id: input.tenant_id,
            engagement_id: input.engagement_id,
            event_type: 'conversation_started',
            event_payload: input.conversation_payload as never,
          },
        }),
        this.prisma.talentEngagementEvent.create({
          data: {
            id: input.transition_event_id,
            tenant_id: input.tenant_id,
            engagement_id: input.engagement_id,
            event_type: 'state_transition',
            event_payload: {
              from_state: current.state,
              to_state: TO_STATE,
            } as never,
          },
        }),
        this.prisma.outboxEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: input.tenant_id,
            event_type: 'engagement.state_transition',
            event_payload: {
              engagement_id: input.engagement_id,
              tenant_id: input.tenant_id,
              from_state: current.state,
              to_state: TO_STATE,
              transition_event_id: input.transition_event_id,
            } as never,
          },
        }),
        // PR-A1c — in-tx metered usage event (Ruling 6 same-transaction).
        recordUsage(this.prisma, {
          tenant_id: input.tenant_id,
          event_type: 'engagement.state_transition',
        }),
      ]);

    // ---- Step 4 + 5: project + return + success log ------------------
    const result: RecordConversationStartedResult = {
      engagement: projectView(updatedRow as TalentJobEngagementRow),
      conversation_event: projectEventView(conversationEventRow as TalentEngagementEventRow),
      transition_event: projectEventView(transitionEventRow as TalentEngagementEventRow),
    };
    this.logger.log({
      event: 'engagement.conversation_started_recorded',
      tenant_id: result.engagement.tenant_id,
      engagement_id: result.engagement.id,
      conversation_event_id: result.conversation_event.id,
      transition_event_id: result.transition_event.id,
      from_state: current.state,
      to_state: result.engagement.state,
      latency_ms: Date.now() - startedAt,
    });
    return result;
  }

  // ---- Helpers ----------------------------------------------------------

  private validateCreateInput(input: CreateEngagementInput): void {
    const UUID_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const identityFields: ReadonlyArray<['id' | 'event_id' | 'tenant_id' | 'talent_id' | 'requisition_id', string]> = [
      ['id', input.id],
      ['event_id', input.event_id],
      ['tenant_id', input.tenant_id],
      ['talent_id', input.talent_id],
      ['requisition_id', input.requisition_id],
    ];
    for (const [name, value] of identityFields) {
      if (typeof value !== 'string' || value.length === 0 || !UUID_REGEX.test(value)) {
        throw new AramoError(
          'VALIDATION_ERROR',
          `CreateEngagementInput.${name} is not a well-formed UUID`,
          400,
          {
            requestId: 'engagement-create',
            details: { invalid_field: name },
          },
        );
      }
    }
    if (
      input.examination_id !== undefined &&
      input.examination_id !== null &&
      !UUID_REGEX.test(input.examination_id)
    ) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'CreateEngagementInput.examination_id is not a well-formed UUID',
        400,
        {
          requestId: 'engagement-create',
          details: { invalid_field: 'examination_id' },
        },
      );
    }
  }

  private logRefused(
    code: 'ENGAGEMENT_REFERENCE_NOT_FOUND',
    input: CreateEngagementInput,
    field: 'talent_id' | 'requisition_id' | 'examination_id',
  ): void {
    this.logger.log({
      event: 'engagement.create_refused',
      error_code: code,
      field,
      tenant_id: input.tenant_id,
      engagement_id: input.id,
    });
  }
}
