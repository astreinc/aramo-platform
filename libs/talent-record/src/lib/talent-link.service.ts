import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { IdentityIndexRepository } from '@aramo/identity-index';
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
// === The in-tenant gate (the validation) ===
//
//   (1) The TalentRecord exists in the requesting tenant (404 if not — this
//       IS the in-tenant gate post-4d).
//   (2) Talent identity exists in Core (TalentRepository.findTalentById) —
//       guard for core_talent_id, UNTOUCHED by 4d.
//   (3) (4d, optional) If a cluster_id is supplied, the PERSON_CLUSTER exists
//       in identity_index.
//
// Failing (2) → 422 TALENT_LINK_INVALID reason='core_talent_not_found';
// failing (3) → 422 reason='cluster_not_found'. 4d COLLAPSED the former
// overlay-existence gate (tenant_overlay_missing) into (1): the global
// PERSON_CLUSTER has no per-tenant relationship, and the tenant relationship
// now lives on the TalentRecord.
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
    // 4d — the PII-free cross-tenant resolution index, for the optional
    // cluster_id link + its cluster-exists validation.
    private readonly identityIndex: IdentityIndexRepository,
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
   *   3. (4d) If a cluster_id is supplied, the PERSON_CLUSTER exists in
   *      identity_index (else 422, details.reason='cluster_not_found').
   *   4. setLink writes the column(s) (tenant-scoped UPDATE).
   *
   * 4d note: the former overlay-existence gate (guard-3, tenant_overlay_
   * missing) is COLLAPSED into guard-1 — the TalentRecord existing in the
   * tenant IS the tenant relationship now; the cross-tenant cluster carries
   * no per-tenant relationship. core_talent_id is UNTOUCHED (still written;
   * consent reads it; owned by the consent re-key directive). cluster_id is
   * the new, optional, post-realignment identity pointer.
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
    cluster_id?: string;
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
    // === Step 2 (4d): the in-tenant gate is now guard-1 (the TalentRecord
    // exists in the tenant — read above). The former overlay-existence gate
    // is removed: the global PERSON_CLUSTER carries no per-tenant relationship,
    // and the tenant relationship lives on the TalentRecord. ===

    // === Step 2b (4d): if a cluster is supplied, it must exist in the
    // PII-free identity_index (cluster-exists validation). ===
    if (args.cluster_id !== undefined) {
      const cluster = await this.identityIndex.findClusterById(args.cluster_id);
      if (cluster === null) {
        throw new AramoError(
          'TALENT_LINK_INVALID',
          'PERSON_CLUSTER not found',
          422,
          {
            requestId: args.requestId,
            details: {
              id: args.talent_record_id,
              cluster_id: args.cluster_id,
              reason: 'cluster_not_found',
            },
          },
        );
      }
    }
    // === Step 3: column write (tenant-scoped). core_talent_id UNTOUCHED;
    // cluster_id written when supplied. ===
    const updated = await this.talentRecordRepo.setLink({
      tenant_id: args.tenant_id,
      id: args.talent_record_id,
      core_talent_id: args.core_talent_id,
      cluster_id: args.cluster_id,
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
