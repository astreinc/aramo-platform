import { Inject, Injectable } from '@nestjs/common';
import { AramoError, type AramoLogger } from '@aramo/common';
import {
  ClientSelectionProcessRepository,
  type ClientSelectionProcessView,
} from '@aramo/client-selection';

// Lane 2 / L2-F (F1) — the "Create Client-Selection from Submittal" composition root
// (apps/api). The ClientSelectionProcess owner lib (@aramo/client-selection) must NOT
// import @aramo/submittal or @aramo/pipeline (I15 / SB-7: Pipeline never writes this
// owner, and the lib stays a pure aggregate). So the cross-aggregate resolution — read
// the Submittal (existence + tenant), derive requisition_id (= submittal.job_id) and
// talent_id, then read the linked Pipeline for the denormalized site_id (nullable, R4)
// — happens HERE, at the composition layer, via parameterized raw SQL. This mirrors the
// L8-B1 SubmitTalentToClientService pattern (raw cross-schema reads on one injected
// connection) but only READS the foreign aggregates; the sole write is the owner lib's
// own atomic create (process + birth event + outbox), so no shared interactive tx is
// needed. A non-existent / cross-tenant / not-visible Submittal is refused with
// CLIENT_SELECTION_SUBMITTAL_INVALID (409) — the F1.1 negative acceptance.

export interface CreateClientSelectionFromSubmittalInput {
  readonly tenant_id: string;
  readonly submittal_id: string;
  readonly created_by_id?: string;
  // Visibility set resolved by the VisibilityInterceptor. null = actor sees all
  // requisitions (no restriction); a Set restricts to those ids. A Submittal whose
  // requisition (job_id) is not in the set is concealed as SUBMITTAL_INVALID (never a
  // 403/existence leak).
  readonly visible_requisition_ids: ReadonlySet<string> | null;
  readonly requestId: string;
}

interface SubmittalRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly talent_id: string;
  readonly job_id: string;
  readonly pipeline_id: string | null;
}

interface PipelineRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string | null;
}

// Minimal DB surface: a parameterized raw-read capability. Typing against this
// interface (rather than a lib's generated PrismaClient) keeps apps/api from leaking a
// concrete prisma type and mirrors the SubmitTalentToClientService OrchestratorDb shape.
interface RawReadDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

@Injectable()
export class ClientSelectionCreateFromSubmittalService {
  constructor(
    @Inject('ClientSelectionCreateDb') private readonly db: RawReadDb,
    private readonly repository: ClientSelectionProcessRepository,
    @Inject('ClientSelectionCreateLogger') private readonly logger: AramoLogger,
  ) {}

  async createFromSubmittal(
    input: CreateClientSelectionFromSubmittalInput,
  ): Promise<{ process: ClientSelectionProcessView; replayed: boolean }> {
    const { tenant_id, submittal_id, visible_requisition_ids, requestId } = input;

    const invalid = (reason: string): AramoError =>
      new AramoError(
        'CLIENT_SELECTION_SUBMITTAL_INVALID',
        'The referenced Submittal is not valid for a new client-selection process',
        409,
        { requestId, details: { submittal_id, reason } },
      );

    // 1. Read the Submittal (existence + tenant). Cross-schema read confined to a
    //    parameterized statement.
    const subs = await this.db.$queryRawUnsafe<SubmittalRow[]>(
      `SELECT "id","tenant_id","talent_id","job_id","pipeline_id"
         FROM "submittal"."TalentSubmittalRecord"
        WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid
        LIMIT 1`,
      submittal_id,
      tenant_id,
    );
    const submittal = subs[0];
    if (submittal === undefined) {
      throw invalid('submittal_not_found');
    }

    // 2. Visibility concealment: a Submittal whose requisition the actor cannot see is
    //    indistinguishable from a non-existent one (SUBMITTAL_INVALID, never a leak).
    if (
      visible_requisition_ids !== null &&
      !visible_requisition_ids.has(submittal.job_id)
    ) {
      throw invalid('submittal_not_visible');
    }

    // 3. Derive site_id from the linked Pipeline (nullable, R4). A submittal with no
    //    pipeline link, or a link that resolves to no pipeline, yields site_id = null.
    let site_id: string | null = null;
    if (submittal.pipeline_id !== null) {
      const pipes = await this.db.$queryRawUnsafe<PipelineRow[]>(
        `SELECT "id","tenant_id","site_id"
           FROM "pipeline"."Pipeline"
          WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid
          LIMIT 1`,
        submittal.pipeline_id,
        tenant_id,
      );
      site_id = pipes[0]?.site_id ?? null;
    }

    // 4. Replay-safe handoff (L3-C). Architectural rule: one Submittal produces at
    //    most one ClientSelectionProcess; a retry with the same submittal_id RETRIEVES
    //    that same process rather than 409-ing a harmless network/application replay.
    //    The replay path re-derives + asserts requisition_id/talent_id consistency — a
    //    genuine mismatch is a conflict (SUBMITTAL_INVALID), never a disguised replay.
    //    (Tenant/visibility were already enforced in steps 1–2 above.)
    const assertConsistent = (p: ClientSelectionProcessView): void => {
      if (p.requisition_id !== submittal.job_id || p.talent_id !== submittal.talent_id) {
        throw invalid('replay_inconsistent');
      }
    };

    const existing = await this.repository.findBySubmittalId({ tenant_id, submittal_id });
    if (existing !== null) {
      assertConsistent(existing);
      this.logger.log({
        event: 'client_selection_process_replayed_from_submittal',
        request_id: requestId,
        tenant_id,
        submittal_id,
        client_selection_process_id: existing.id,
      });
      return { process: existing, replayed: true };
    }

    // 5. Owner create (atomic: process + birth event + outbox). The @@unique on
    //    submittal_id remains the DB backstop.
    try {
      const view = await this.repository.create({
        tenant_id,
        submittal_id,
        requisition_id: submittal.job_id,
        talent_id: submittal.talent_id,
        site_id,
        ...(input.created_by_id === undefined ? {} : { created_by_id: input.created_by_id }),
        requestId,
      });

      this.logger.log({
        event: 'client_selection_process_created_from_submittal',
        request_id: requestId,
        tenant_id,
        submittal_id,
        client_selection_process_id: view.id,
        requisition_id: submittal.job_id,
        site_id,
      });

      return { process: view, replayed: false };
    } catch (err) {
      // Concurrent-create race: the @@unique(submittal_id) loser re-fetches onto the
      //   same replay path (still consistency-checked), so two simultaneous retries
      //   both resolve to the one process rather than one of them 409-ing.
      if (err instanceof AramoError && err.code === 'CLIENT_SELECTION_SUBMITTAL_INVALID') {
        const raced = await this.repository.findBySubmittalId({ tenant_id, submittal_id });
        if (raced !== null) {
          assertConsistent(raced);
          return { process: raced, replayed: true };
        }
      }
      throw err;
    }
  }
}
