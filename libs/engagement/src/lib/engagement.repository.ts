import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';
import { ExaminationRepository } from '@aramo/examination';
import { JobDomainRepository } from '@aramo/job-domain';
import { TalentRepository } from '@aramo/talent';

import { canTransition, type EngagementStateValue } from './engagement-state.js';
import type { EngagementEventTypeValue } from './engagement-event.js';
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

    // ---- Step 3: atomic transaction (engagement.create + event.create) -
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

    // ---- Step 3: atomic transaction (engagement.update + event.create) -
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
