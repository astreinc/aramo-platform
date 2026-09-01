import { Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError } from '@aramo/common';

import {
  isTerminalClientSelectionState,
  type ClientSelectionState,
} from './client-selection-state.js';
import {
  canTransitionInterviewSession,
  type InterviewSessionState,
} from './interview-session-state.js';
import type { InterviewSessionView } from './dto/interview-session.view.js';
import { PrismaService } from './prisma/prisma.service.js';

interface SessionRow {
  id: string;
  tenant_id: string;
  client_selection_process_id: string;
  requisition_id: string;
  talent_record_id: string;
  site_id: string | null;
  interview_type: string;
  round: number;
  scheduled_at: Date;
  interviewer_user_ids: string[];
  state: InterviewSessionState;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface ParentProcessRow {
  id: string;
  requisition_id: string;
  talent_id: string;
  site_id: string | null;
  state: ClientSelectionState;
}

function projectView(row: SessionRow): InterviewSessionView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    client_selection_process_id: row.client_selection_process_id,
    requisition_id: row.requisition_id,
    talent_record_id: row.talent_record_id,
    site_id: row.site_id,
    interview_type: row.interview_type,
    round: row.round,
    scheduled_at: row.scheduled_at.toISOString(),
    interviewer_user_ids: [...row.interviewer_user_ids],
    state: row.state,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// Lane 2 / L2-F (F2) — the InterviewSession write + read surface + the ENFORCED session
// state machine. Sessions are children of a ClientSelectionProcess (UUID-ref, no FK).
// Scheduling requires the parent process to exist in-tenant, be visible, and be
// NON-TERMINAL (R6; else CLIENT_SELECTION_PROCESS_INVALID 409, concealing). Every
// schedule/transition appends one immutable ClientSelectionEvent (subject_type='session')
// + one OutboxEvent in the SAME tx — reusing the process's event log + outbox (no new
// table, no new drain namespace). Session reads/transitions conceal cross-visibility
// rows as 404 (never 403) via the session's denormalized requisition_id.
@Injectable()
export class InterviewSessionRepository {
  private readonly logger = new Logger(InterviewSessionRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // Schedule a session under a valid, visible, non-terminal parent process. Denormalizes
  // requisition_id/talent_record_id/site_id from the parent. Any parent failure mode
  // (missing / cross-tenant / not-visible / terminal) collapses to the SAME 409.
  async scheduleInterview(args: {
    tenant_id: string;
    client_selection_process_id: string;
    interview_type: string;
    round?: number;
    scheduled_at: Date;
    interviewer_user_ids?: readonly string[];
    created_by_id?: string;
    requestId: string;
    visible_requisition_ids: ReadonlySet<string> | null;
  }): Promise<InterviewSessionView> {
    const parent = (await this.prisma.clientSelectionProcess.findFirst({
      where: { tenant_id: args.tenant_id, id: args.client_selection_process_id },
    })) as ParentProcessRow | null;

    const invalid = (reason: string): AramoError =>
      new AramoError(
        'CLIENT_SELECTION_PROCESS_INVALID',
        'The client-selection process is not valid for scheduling an interview',
        409,
        {
          requestId: args.requestId,
          details: { client_selection_process_id: args.client_selection_process_id, reason },
        },
      );

    if (parent === null) {
      throw invalid('process_not_found');
    }
    if (
      args.visible_requisition_ids !== null &&
      !args.visible_requisition_ids.has(parent.requisition_id)
    ) {
      throw invalid('process_not_visible');
    }
    if (isTerminalClientSelectionState(parent.state)) {
      throw invalid('process_terminal');
    }

    const round = args.round ?? 1;
    const interviewerIds = args.interviewer_user_ids
      ? [...args.interviewer_user_ids]
      : [];

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.interviewSession.create({
        data: {
          tenant_id: args.tenant_id,
          client_selection_process_id: parent.id,
          requisition_id: parent.requisition_id,
          talent_record_id: parent.talent_id,
          site_id: parent.site_id,
          interview_type: args.interview_type,
          round,
          scheduled_at: args.scheduled_at,
          interviewer_user_ids: interviewerIds,
          state: 'SCHEDULED',
          ...(args.created_by_id === undefined
            ? {}
            : { created_by_id: args.created_by_id }),
        },
      });
      // Birth event on the SHARED log with subject_type='session'.
      await tx.clientSelectionEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: args.tenant_id,
          subject_type: 'session',
          subject_id: created.id,
          event_type: 'client_selection.interview.scheduled',
          event_payload: {
            interview_session_id: created.id,
            client_selection_process_id: parent.id,
            requisition_id: parent.requisition_id,
            talent_record_id: parent.talent_id,
            round,
            scheduled_at: args.scheduled_at.toISOString(),
            state: 'SCHEDULED',
          },
        },
      });
      await tx.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: args.tenant_id,
          event_type: 'client_selection.interview.scheduled',
          event_payload: {
            interview_session_id: created.id,
            client_selection_process_id: parent.id,
            requisition_id: parent.requisition_id,
          },
        },
      });
      return created;
    }).catch((err: unknown): never => {
      // L3-D — a duplicate schedule at the same (process, round) trips the unique index.
      // Translate the raw P2002 into the stable domain error rather than leaking it.
      if (isRoundUniqueViolation(err)) {
        throw new AramoError(
          'INTERVIEW_ROUND_EXISTS',
          'An interview session already exists for this process and round',
          409,
          {
            requestId: args.requestId,
            details: { client_selection_process_id: parent.id, round },
          },
        );
      }
      throw err;
    });

    this.logger.log({
      event: 'interview_session_scheduled',
      tenant_id: args.tenant_id,
      interview_session_id: (row as SessionRow).id,
      client_selection_process_id: parent.id,
    });
    return projectView(row as SessionRow);
  }

  async findSessionById(args: {
    tenant_id: string;
    id: string;
    visible_requisition_ids: ReadonlySet<string> | null;
  }): Promise<InterviewSessionView | null> {
    const row = (await this.prisma.interviewSession.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    })) as SessionRow | null;
    if (row === null) return null;
    if (
      args.visible_requisition_ids !== null &&
      !args.visible_requisition_ids.has(row.requisition_id)
    ) {
      return null; // concealed — caller surfaces 404
    }
    return projectView(row);
  }

  // Lane 2 / L2-H — the interview sub-state read for the unified journey composer.
  // Returns the MOST-RECENT session (scheduled_at desc) for the process, or null when
  // none exists (a coherent absence — never a fabricated state). Visibility is enforced
  // by the composer loading the pipeline episode through findByIdForActor FIRST (house
  // pattern); the process + its sessions share that requisition's visibility boundary.
  // Lane 2 / L2-I (D4b) — the FIRST-interview-per-(talent, requisition)-grain read for the
  // reporting hiring funnel (consumed via the reporting-owned INTERVIEW_HISTORY_PORT adapter;
  // reporting never imports this lib — A7 seam). Returns the earliest scheduled interview instant
  // per grain, optionally restricted to a requisition visibility set.
  async findFirstInterviewByGrain(args: {
    tenant_id: string;
    requisition_ids?: readonly string[];
  }): Promise<Array<{ requisition_id: string; talent_record_id: string; first_interview_at: Date }>> {
    const hasReq = args.requisition_ids !== undefined;
    if (hasReq && args.requisition_ids!.length === 0) return [];
    const params: unknown[] = [args.tenant_id];
    if (hasReq) params.push([...args.requisition_ids!]);
    const reqClause = hasReq ? `AND s."requisition_id" = ANY($2::uuid[])` : '';
    const rows = await this.prisma.$queryRawUnsafe<Array<{ requisition_id: string; talent_record_id: string; first_interview_at: Date }>>(
      `SELECT s."requisition_id", s."talent_record_id", MIN(s."scheduled_at") AS first_interview_at
         FROM "client_selection"."InterviewSession" s
        WHERE s."tenant_id" = $1::uuid ${reqClause}
        GROUP BY s."requisition_id", s."talent_record_id"`,
      ...params,
    );
    return rows.map((r) => ({ requisition_id: r.requisition_id, talent_record_id: r.talent_record_id, first_interview_at: r.first_interview_at }));
  }

  async findLatestByProcess(args: {
    tenant_id: string;
    client_selection_process_id: string;
  }): Promise<InterviewSessionView | null> {
    const row = (await this.prisma.interviewSession.findFirst({
      where: {
        tenant_id: args.tenant_id,
        client_selection_process_id: args.client_selection_process_id,
      },
      orderBy: { scheduled_at: 'desc' },
    })) as SessionRow | null;
    return row === null ? null : projectView(row);
  }

  // Drive a legal, CAS-guarded session transition. Concealment (404) + CAS (409) +
  // legality (422) precede the atomic tx (UPDATE + event + outbox). RESCHEDULED also
  // sets the new scheduled_at. There is NO no-op short-circuit: the only same-state
  // legal edge (RESCHEDULED→RESCHEDULED) is a real re-reschedule.
  async transitionInterview(args: {
    tenant_id: string;
    id: string;
    to_state: InterviewSessionState;
    expected_version: number;
    scheduled_at?: Date;
    changed_by_id: string;
    requestId: string;
    visible_requisition_ids: ReadonlySet<string> | null;
    note?: string;
  }): Promise<InterviewSessionView> {
    const current = (await this.prisma.interviewSession.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    })) as SessionRow | null;
    if (
      current === null ||
      (args.visible_requisition_ids !== null &&
        !args.visible_requisition_ids.has(current.requisition_id))
    ) {
      throw new AramoError(
        'NOT_FOUND',
        'Interview session not found in tenant (or not visible to actor)',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }

    if (args.expected_version !== current.version) {
      throw new AramoError(
        'INTERVIEW_SESSION_TRANSITION_CONFLICT',
        'Interview session was modified concurrently; refresh and retry',
        409,
        {
          requestId: args.requestId,
          details: {
            interview_session_id: args.id,
            current_state: current.state,
            current_version: current.version,
          },
        },
      );
    }

    if (!canTransitionInterviewSession(current.state, args.to_state)) {
      throw new AramoError(
        'INVALID_INTERVIEW_SESSION_TRANSITION',
        `Illegal interview-session transition: ${current.state} -> ${args.to_state}`,
        422,
        {
          requestId: args.requestId,
          details: {
            interview_session_id: args.id,
            from_state: current.state,
            to_state: args.to_state,
          },
        },
      );
    }

    const fromState = current.state;
    const note = args.note ?? null;
    const rescheduleAt =
      args.to_state === 'RESCHEDULED' && args.scheduled_at !== undefined
        ? args.scheduled_at
        : undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.interviewSession.update({
        where: { id: args.id },
        data: {
          state: args.to_state,
          version: { increment: 1 },
          ...(rescheduleAt === undefined ? {} : { scheduled_at: rescheduleAt }),
        },
      });
      await tx.clientSelectionEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: args.tenant_id,
          subject_type: 'session',
          subject_id: args.id,
          event_type: 'client_selection.interview.state_transition',
          event_payload: {
            interview_session_id: args.id,
            from_state: fromState,
            to_state: args.to_state,
            version: (u as SessionRow).version,
            ...(rescheduleAt === undefined
              ? {}
              : { scheduled_at: rescheduleAt.toISOString() }),
            note,
          },
        },
      });
      await tx.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: args.tenant_id,
          event_type: 'client_selection.interview.state_transition',
          event_payload: {
            interview_session_id: args.id,
            from_state: fromState,
            to_state: args.to_state,
            version: (u as SessionRow).version,
          },
        },
      });
      return u;
    });

    this.logger.log({
      event: 'interview_session_transitioned',
      tenant_id: args.tenant_id,
      interview_session_id: args.id,
      from_state: fromState,
      to_state: args.to_state,
    });
    return projectView(updated as SessionRow);
  }
}

// L3-D — detect the (process, round) unique-index violation. A Prisma raw-index (not a
// modelled relation) violation surfaces at meta.driverAdapterError.cause.originalMessage
// rather than meta.target under Prisma 7 + PrismaPg, so match both — plus the index name
// in the message — before translating to INTERVIEW_ROUND_EXISTS.
function isRoundUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    code?: unknown;
    meta?: {
      target?: unknown;
      driverAdapterError?: { cause?: { originalMessage?: unknown } };
    };
    message?: unknown;
  };
  if (e.code !== 'P2002') return false;
  const named = 'InterviewSession_process_round_key';
  const target = e.meta?.target;
  const original = e.meta?.driverAdapterError?.cause?.originalMessage;
  return (
    (typeof target === 'string' && target.includes(named)) ||
    (Array.isArray(target) &&
      target.some((t) => typeof t === 'string' && t.includes(named))) ||
    (typeof original === 'string' && original.includes(named)) ||
    (typeof e.message === 'string' && e.message.includes(named))
  );
}
