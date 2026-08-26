import { Injectable } from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import { AramoError } from '@aramo/common';
import {
  CommunicationCursorDecodeError,
  CommunicationInteractionNotFoundError,
  CommunicationsRepository,
  CommunicationsService,
  decodeTimelineCursor,
  encodeTimelineCursor,
} from '@aramo/communications';

import { toInteractionView } from './interaction-view.js';
import type {
  RecordDispositionDto,
  TalentCommunicationTimelineResponseDto,
} from './dto/communications.dto.js';

// COMM-B7 — apps/api orchestration for the post-call workflow: record a
// disposition, and read a Talent's communication timeline. Composition-root
// service (no new nx edges). Timeline lookup uses Communications associations
// ONLY — never a Requisition/Activity join, and never an Activity projection.

const DEFAULT_TIMELINE_LIMIT = 50;
const MAX_TIMELINE_LIMIT = 200;
const NOTES_SCOPE = 'communication:notes:write';

@Injectable()
export class CommunicationTimelineService {
  constructor(
    private readonly comms: CommunicationsService,
    private readonly repo: CommunicationsRepository,
  ) {}

  /**
   * Record a disposition (append-only) on an interaction. State-agnostic: a
   * disposition may be recorded against any existing interaction (recruiter
   * timing legitimately races provider webhook convergence). Tenant-safe: a
   * cross-tenant / missing interaction is COMMUNICATION_INTERACTION_NOT_FOUND
   * (404), never a cross-tenant disclosure. When notes is present and non-blank
   * the caller must ALSO hold communication:notes:write. do_not_contact is a
   * recorded outcome ONLY — this path never mutates consent or any flag.
   */
  async recordDisposition(
    auth: AuthContextType,
    interactionId: string,
    dto: RecordDispositionDto,
    requestId: string,
  ): Promise<{ id: string }> {
    const notes = typeof dto.notes === 'string' ? dto.notes : null;
    const hasNotes = notes !== null && notes.trim().length > 0;
    if (hasNotes && !auth.scopes.includes(NOTES_SCOPE)) {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'recording notes on a disposition requires communication:notes:write',
        403,
        { requestId, details: { required_scope: NOTES_SCOPE } },
      );
    }
    try {
      return await this.comms.dispose({
        tenant_id: auth.tenant_id,
        interaction_id: interactionId,
        disposition: dto.disposition,
        notes,
        dispositioned_by_id: auth.sub,
      });
    } catch (err) {
      if (err instanceof CommunicationInteractionNotFoundError) {
        throw new AramoError(
          'COMMUNICATION_INTERACTION_NOT_FOUND',
          'Communication interaction not found in tenant',
          404,
          { requestId, details: { interaction_id: interactionId } },
        );
      }
      throw err;
    }
  }

  /**
   * The Talent communication timeline — interactions linked to the talent via a
   * `subject` association, ordered (created_at DESC, id DESC), each carrying its
   * disposition history. Keyset paginated. An unknown talent (or one with no
   * communications) is a 200 empty page, NEVER a 404.
   */
  async getTalentTimeline(
    tenantId: string,
    talentId: string,
    query: { limit?: string; cursor?: string },
    requestId: string,
  ): Promise<TalentCommunicationTimelineResponseDto> {
    const limit = this.parseLimit(query.limit, requestId);
    const cursor = this.parseCursor(query.cursor, requestId);

    const rows = await this.repo.listInteractionsForTalentKeyset(tenantId, talentId, limit, cursor);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const items = await Promise.all(
      page.map(async (row) => {
        const dispositions = await this.repo.listDispositions(tenantId, row.id);
        return {
          ...toInteractionView(row),
          dispositions: dispositions.map((d) => ({
            id: d.id,
            disposition: d.disposition,
            notes: d.notes,
            dispositioned_at: d.dispositioned_at.toISOString(),
          })),
        };
      }),
    );

    const last = page[page.length - 1];
    const next_cursor =
      hasMore && last !== undefined
        ? encodeTimelineCursor({ created_at: last.created_at, interaction_id: last.id })
        : null;

    return { items, next_cursor };
  }

  private parseLimit(raw: string | undefined, requestId: string): number {
    if (raw === undefined) return DEFAULT_TIMELINE_LIMIT;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TIMELINE_LIMIT) {
      throw new AramoError('VALIDATION_ERROR', 'limit must be an integer in [1, 200]', 400, {
        requestId,
        details: { invalid_field: 'limit' },
      });
    }
    return n;
  }

  private parseCursor(
    raw: string | undefined,
    requestId: string,
  ): { created_at: Date; interaction_id: string } | undefined {
    if (raw === undefined || raw.length === 0) return undefined;
    try {
      return decodeTimelineCursor(raw);
    } catch (err) {
      if (err instanceof CommunicationCursorDecodeError) {
        throw new AramoError('VALIDATION_ERROR', 'invalid cursor', 400, {
          requestId,
          details: { invalid_field: 'cursor' },
        });
      }
      throw err;
    }
  }
}
