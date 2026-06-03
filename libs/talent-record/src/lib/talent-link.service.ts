import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { TalentRepository } from '@aramo/talent';

import type { TalentLinkView } from './dto/talent-link.view.js';
import { TalentRecordRepository } from './talent-record.repository.js';

// TalentLinkService — PR-A5b-2 (the keystone of the ATS↔Core seam).
//
// === SACRED BOUNDARIES (enforced structurally) ===
//
// LINK-NOT-CREATE: this service NEVER calls
// `talentRepository.createTalent` or `createOverlay`. It only READS
// Core (to validate the chosen id) and WRITES the ATS-side
// `core_talent_id` column. The integration spec asserts this with a
// bit-identical `talent.Talent` + `talent.TalentTenantOverlay`
// row-count pre/post any link operation.
//
// ASSOCIATE-NOT-RESOLVE: the linker takes `core_talent_id` as an
// explicit input parameter. There is NO code path that searches
// `talent.*` by email / name / phone / etc. to infer it. The libs/
// talent + libs/identity surface carries NO `findTalentByEmail` /
// `resolveIdentity` method (confirmed by grep). The keystone is the
// WIRING — picking the right id to wire is a separate concern (a
// recruiter-driven UI today, a future identity-resolver tomorrow —
// Tier 3, out of scope here).
//
// === The two-step in-tenant gate (the validation) ===
//
//   (1) Talent identity exists in Core (TalentRepository.findTalentById).
//   (2) The requesting tenant has a TalentTenantOverlay for that
//       identity (TalentRepository.findOverlayByTenant by the
//       (talent_id, tenant_id) unique pair).
//
// Failing either gate → 422 TALENT_LINK_INVALID with
// details.reason ∈ {'core_talent_not_found', 'tenant_overlay_missing'}.
// The TalentRecord-not-in-tenant case is 404 NOT_FOUND verbatim
// (existing pattern, no new code needed for the ATS-side miss).
//
// === Why this lives in a dedicated service (not the controller, not
//     the repository) ===
//
// - Controller is HTTP-shaped (DTOs, guards) — keeping the cross-lib
//   orchestration out of it preserves the thin-controller pattern.
// - TalentRecordRepository is data-only (row reads / writes) — pulling
//   a cross-lib repo dependency into it would conflate orchestration
//   with data access.
// - A dedicated service is the M5 PR-3 EngagementRepository precedent
//   in reverse: there, the repository injected TalentRepository
//   because the orchestration WAS the data write; here, the
//   orchestration is the in-tenant gate + a column write — a service
//   surface fits naturally.

@Injectable()
export class TalentLinkService {
  private readonly logger = new Logger(TalentLinkService.name);

  constructor(
    private readonly talentRecordRepo: TalentRecordRepository,
    private readonly talentRepo: TalentRepository,
  ) {}

  /**
   * Get the current link for a TalentRecord (or null if unlinked).
   * Tenant-scoped read.
   */
  async getLink(args: {
    tenant_id: string;
    talent_record_id: string;
    requestId: string;
  }): Promise<TalentLinkView> {
    const record = await this.talentRecordRepo.findById({
      tenant_id: args.tenant_id,
      id: args.talent_record_id,
    });
    if (record === null) {
      throw new AramoError(
        'NOT_FOUND',
        'TalentRecord not found in tenant',
        404,
        {
          requestId: args.requestId,
          details: { id: args.talent_record_id },
        },
      );
    }
    return {
      talent_record_id: record.id,
      core_talent_id: record.core_talent_id,
    };
  }

  /**
   * Associate (link) the TalentRecord with a given Core Talent.
   *
   * SACRED BOUNDARIES:
   *   - LINK-NOT-CREATE — never calls createTalent/createOverlay.
   *   - ASSOCIATE-NOT-RESOLVE — core_talent_id is an explicit input.
   *
   * Validation (in order):
   *   1. The TalentRecord exists in the requesting tenant (else 404).
   *   2. The Core Talent identity exists (else 422,
   *      details.reason='core_talent_not_found').
   *   3. The requesting tenant has an overlay for the Talent (else
   *      422, details.reason='tenant_overlay_missing').
   *   4. setLink writes the column (tenant-scoped UPDATE).
   *
   * Idempotent: linking to the same id again is a no-op write that
   * succeeds. Re-linking to a DIFFERENT id requires unlink first
   * (defensive — recruiters should make the change explicit; the
   * service detects this and refuses with a clear message).
   */
  async link(args: {
    tenant_id: string;
    talent_record_id: string;
    core_talent_id: string;
    requestId: string;
  }): Promise<TalentLinkView> {
    const existing = await this.talentRecordRepo.findById({
      tenant_id: args.tenant_id,
      id: args.talent_record_id,
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'TalentRecord not found in tenant',
        404,
        {
          requestId: args.requestId,
          details: { id: args.talent_record_id },
        },
      );
    }
    // Idempotency: already linked to the same id → return unchanged.
    if (existing.core_talent_id === args.core_talent_id) {
      this.logger.log({
        event: 'talent_link_noop_same_id',
        tenant_id: args.tenant_id,
        talent_record_id: args.talent_record_id,
        core_talent_id: args.core_talent_id,
      });
      return {
        talent_record_id: existing.id,
        core_talent_id: existing.core_talent_id,
      };
    }
    // Refuse silent re-link to a DIFFERENT id — the recruiter must
    // unlink first. This avoids accidental rewrites masking an
    // identity confusion.
    if (
      existing.core_talent_id !== null &&
      existing.core_talent_id !== args.core_talent_id
    ) {
      throw new AramoError(
        'TALENT_LINK_INVALID',
        'TalentRecord is already linked to a different Core Talent; unlink first',
        422,
        {
          requestId: args.requestId,
          details: {
            id: args.talent_record_id,
            current_core_talent_id: existing.core_talent_id,
            requested_core_talent_id: args.core_talent_id,
            reason: 'already_linked_to_different_id',
          },
        },
      );
    }
    // === Step 1: Core identity exists (LINK-NOT-CREATE: read only). ===
    const coreTalent = await this.talentRepo.findTalentById({
      id: args.core_talent_id,
    });
    if (coreTalent === null) {
      throw new AramoError(
        'TALENT_LINK_INVALID',
        'Core Talent not found',
        422,
        {
          requestId: args.requestId,
          details: {
            id: args.talent_record_id,
            core_talent_id: args.core_talent_id,
            reason: 'core_talent_not_found',
          },
        },
      );
    }
    // === Step 2: tenant has an overlay for it (the in-tenant gate). ===
    const overlay = await this.talentRepo.findOverlayByTenant({
      talent_id: args.core_talent_id,
      tenant_id: args.tenant_id,
    });
    if (overlay === null) {
      throw new AramoError(
        'TALENT_LINK_INVALID',
        'Core Talent has no overlay for this tenant',
        422,
        {
          requestId: args.requestId,
          details: {
            id: args.talent_record_id,
            core_talent_id: args.core_talent_id,
            reason: 'tenant_overlay_missing',
          },
        },
      );
    }
    // === Step 3: column write (tenant-scoped). ===
    const updated = await this.talentRecordRepo.setLink({
      tenant_id: args.tenant_id,
      id: args.talent_record_id,
      core_talent_id: args.core_talent_id,
    });
    if (updated === null) {
      // Defensive: row vanished between the initial read and the
      // updateMany (cross-thread delete). Surface as NOT_FOUND.
      throw new AramoError(
        'NOT_FOUND',
        'TalentRecord not found in tenant',
        404,
        {
          requestId: args.requestId,
          details: { id: args.talent_record_id },
        },
      );
    }
    this.logger.log({
      event: 'talent_link_set',
      tenant_id: args.tenant_id,
      talent_record_id: args.talent_record_id,
      core_talent_id: args.core_talent_id,
    });
    return {
      talent_record_id: updated.id,
      core_talent_id: updated.core_talent_id,
    };
  }

  /**
   * Clear (unlink) the TalentRecord's Core Talent reference.
   * Tenant-scoped. Idempotent: unlinking an already-unlinked record
   * is a no-op.
   */
  async unlink(args: {
    tenant_id: string;
    talent_record_id: string;
    requestId: string;
  }): Promise<TalentLinkView> {
    const existing = await this.talentRecordRepo.findById({
      tenant_id: args.tenant_id,
      id: args.talent_record_id,
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'TalentRecord not found in tenant',
        404,
        {
          requestId: args.requestId,
          details: { id: args.talent_record_id },
        },
      );
    }
    if (existing.core_talent_id === null) {
      // Already unlinked — idempotent no-op.
      return {
        talent_record_id: existing.id,
        core_talent_id: null,
      };
    }
    const updated = await this.talentRecordRepo.clearLink({
      tenant_id: args.tenant_id,
      id: args.talent_record_id,
    });
    if (updated === null) {
      throw new AramoError(
        'NOT_FOUND',
        'TalentRecord not found in tenant',
        404,
        {
          requestId: args.requestId,
          details: { id: args.talent_record_id },
        },
      );
    }
    this.logger.log({
      event: 'talent_link_cleared',
      tenant_id: args.tenant_id,
      talent_record_id: args.talent_record_id,
      previous_core_talent_id: existing.core_talent_id,
    });
    return {
      talent_record_id: updated.id,
      core_talent_id: null,
    };
  }
}
