import { Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError } from '@aramo/common';

import {
  canTransitionClientSelection,
  type ClientSelectionState,
} from './client-selection-state.js';
import type { ClientSelectionProcessView } from './dto/client-selection-process.view.js';
import { PrismaService } from './prisma/prisma.service.js';

interface ProcessRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  submittal_id: string;
  requisition_id: string;
  talent_id: string;
  state: ClientSelectionState;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function projectView(row: ProcessRow): ClientSelectionProcessView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    submittal_id: row.submittal_id,
    requisition_id: row.requisition_id,
    talent_id: row.talent_id,
    state: row.state,
    version: row.version,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// Lane 2 / L2-F (F1) — the ClientSelectionProcess write + read surface + the ENFORCED
// state machine. One process per Submittal lineage (the @@unique on submittal_id is
// the DB floor; the create's governed existence check is the documented refusal).
// Every transition is CAS-guarded + appends one immutable ClientSelectionEvent + one
// OutboxEvent in the SAME tx (atomic). Reads/writes conceal cross-visibility rows as
// 404 (never 403) — the pipeline concealment precedent.
@Injectable()
export class ClientSelectionProcessRepository {
  private readonly logger = new Logger(ClientSelectionProcessRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // Create the process at CLIENT_REVIEW. The apps/api orchestration has already
  // resolved + validated the Submittal lineage (existence + same tenant) and the
  // denormalized keys (requisition_id/talent_id from the Submittal, site_id from the
  // linked Pipeline). A duplicate Submittal link trips the @@unique →
  // CLIENT_SELECTION_SUBMITTAL_INVALID (409).
  async create(args: {
    tenant_id: string;
    submittal_id: string;
    requisition_id: string;
    talent_id: string;
    site_id?: string | null;
    created_by_id?: string;
    requestId?: string;
  }): Promise<ClientSelectionProcessView> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.clientSelectionProcess.create({
          data: {
            tenant_id: args.tenant_id,
            site_id: args.site_id ?? null,
            submittal_id: args.submittal_id,
            requisition_id: args.requisition_id,
            talent_id: args.talent_id,
            state: 'CLIENT_REVIEW',
            ...(args.created_by_id === undefined
              ? {}
              : { created_by_id: args.created_by_id }),
          },
        });
        // Birth event (null -> CLIENT_REVIEW) so the append-only log is complete from
        // the first instant.
        await tx.clientSelectionEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: args.tenant_id,
            subject_type: 'process',
            subject_id: created.id,
            event_type: 'client_selection.process.created',
            event_payload: {
              client_selection_process_id: created.id,
              submittal_id: args.submittal_id,
              requisition_id: args.requisition_id,
              talent_id: args.talent_id,
              state: 'CLIENT_REVIEW',
            },
          },
        });
        await tx.outboxEvent.create({
          data: {
            id: uuidv7(),
            tenant_id: args.tenant_id,
            event_type: 'client_selection.process.created',
            event_payload: {
              client_selection_process_id: created.id,
              submittal_id: args.submittal_id,
              requisition_id: args.requisition_id,
              talent_id: args.talent_id,
            },
          },
        });
        return created;
      });
      return projectView(row as ProcessRow);
    } catch (err) {
      if (isSubmittalUniqueViolation(err)) {
        throw new AramoError(
          'CLIENT_SELECTION_SUBMITTAL_INVALID',
          'A client-selection process already exists for this submittal',
          409,
          {
            requestId: args.requestId ?? 'client-selection-create',
            details: { submittal_id: args.submittal_id },
          },
        );
      }
      throw err;
    }
  }

  async findById(args: {
    tenant_id: string;
    id: string;
    visible_requisition_ids: ReadonlySet<string> | null;
  }): Promise<ClientSelectionProcessView | null> {
    const row = await this.prisma.clientSelectionProcess.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    if (row === null) return null;
    if (
      args.visible_requisition_ids !== null &&
      !args.visible_requisition_ids.has((row as ProcessRow).requisition_id)
    ) {
      return null; // concealed — caller surfaces 404
    }
    return projectView(row as ProcessRow);
  }

  async findBySubmittalId(args: {
    tenant_id: string;
    submittal_id: string;
  }): Promise<ClientSelectionProcessView | null> {
    const row = await this.prisma.clientSelectionProcess.findFirst({
      where: { tenant_id: args.tenant_id, submittal_id: args.submittal_id },
    });
    return row === null ? null : projectView(row as ProcessRow);
  }

  // Drive a legal, CAS-guarded state transition. Concealment (404) + CAS (409) +
  // legality (422) precede the atomic tx (UPDATE + event + outbox).
  async transition(args: {
    tenant_id: string;
    id: string;
    to_state: ClientSelectionState;
    expected_version: number;
    changed_by_id: string;
    requestId: string;
    visible_requisition_ids: ReadonlySet<string> | null;
    note?: string;
  }): Promise<ClientSelectionProcessView> {
    const current = await this.prisma.clientSelectionProcess.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    // Concealment: missing OR not-visible both surface as the SAME 404.
    if (
      current === null ||
      (args.visible_requisition_ids !== null &&
        !args.visible_requisition_ids.has((current as ProcessRow).requisition_id))
    ) {
      throw new AramoError(
        'NOT_FOUND',
        'Client-selection process not found in tenant (or not visible to actor)',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }

    const cur = current as ProcessRow;
    // CAS — a stale expected_version means a concurrent transition already advanced
    // the row; refuse before any write.
    if (args.expected_version !== cur.version) {
      throw new AramoError(
        'CLIENT_SELECTION_TRANSITION_CONFLICT',
        'Client-selection process was modified concurrently; refresh and retry',
        409,
        {
          requestId: args.requestId,
          details: {
            client_selection_process_id: args.id,
            current_state: cur.state,
            current_version: cur.version,
          },
        },
      );
    }

    // No-op guard — same state, no write.
    if (cur.state === args.to_state) {
      return projectView(cur);
    }

    // Legality — illegal target → 422.
    if (!canTransitionClientSelection(cur.state, args.to_state)) {
      throw new AramoError(
        'INVALID_CLIENT_SELECTION_TRANSITION',
        `Illegal client-selection transition: ${cur.state} -> ${args.to_state}`,
        422,
        {
          requestId: args.requestId,
          details: {
            client_selection_process_id: args.id,
            from_state: cur.state,
            to_state: args.to_state,
          },
        },
      );
    }

    const fromState = cur.state;
    const note = args.note ?? null;
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.clientSelectionProcess.update({
        where: { id: args.id },
        data: { state: args.to_state, version: { increment: 1 } },
      });
      await tx.clientSelectionEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: args.tenant_id,
          subject_type: 'process',
          subject_id: args.id,
          event_type: 'client_selection.process.state_transition',
          event_payload: {
            client_selection_process_id: args.id,
            from_state: fromState,
            to_state: args.to_state,
            version: u.version,
            note,
          },
        },
      });
      await tx.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: args.tenant_id,
          event_type: 'client_selection.process.state_transition',
          event_payload: {
            client_selection_process_id: args.id,
            from_state: fromState,
            to_state: args.to_state,
            version: u.version,
          },
        },
      });
      return u;
    });

    this.logger.log({
      event: 'client_selection_transitioned',
      tenant_id: args.tenant_id,
      client_selection_process_id: args.id,
      from_state: fromState,
      to_state: args.to_state,
    });
    return projectView(updated as ProcessRow);
  }
}

// The @@unique(submittal_id) violation → exact-name translation (Prisma-7/PrismaPg:
// check meta.target AND the driver-adapter originalMessage, per the P2002 shape).
function isSubmittalUniqueViolation(err: unknown): boolean {
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
  const named = 'ClientSelectionProcess_submittal_id_key';
  const target = e.meta?.target;
  const original = e.meta?.driverAdapterError?.cause?.originalMessage;
  return (
    (typeof target === 'string' && target.includes(named)) ||
    (Array.isArray(target) &&
      target.some((t) => typeof t === 'string' && t.includes(named))) ||
    (typeof original === 'string' && original.includes(named)) ||
    (typeof e.message === 'string' &&
      (e.message.includes(named) || e.message.includes('submittal_id')))
  );
}
