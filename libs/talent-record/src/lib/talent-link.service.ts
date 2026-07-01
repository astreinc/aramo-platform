import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { IdentityIndexRepository } from '@aramo/identity-index';

import type { TalentLinkView } from './dto/talent-link.view.js';
import { TalentRecordRepository } from './talent-record.repository.js';

// TalentLinkService — the keystone of the ATS↔identity seam.
//
// === SACRED BOUNDARIES (enforced structurally) ===
//
// LINK-NOT-CREATE: this service NEVER mints an identity. It only READS
// identity_index (to validate the chosen cluster) and WRITES the ATS-side
// `cluster_id` column. The integration spec asserts the identity_index
// row-counts are bit-identical pre/post any link operation.
//
// ASSOCIATE-NOT-RESOLVE: the linker takes `cluster_id` as an explicit
// input parameter. There is NO code path that searches identity_index by
// email / name / phone / etc. to infer it. Picking the right cluster id to
// wire is a separate concern (a recruiter-driven UI today, a future
// identity-resolver tomorrow — out of scope here).
//
// === The in-tenant gate (the validation) ===
//
//   (1) The TalentRecord exists in the requesting tenant (404 if not — this
//       IS the in-tenant gate).
//   (2) The PERSON_CLUSTER exists in identity_index
//       (IdentityIndexRepository.findClusterById).
//
// Failing (2) → 422 TALENT_LINK_INVALID reason='cluster_not_found'.
//
// 4e-rest: the Core-Talent link (core_talent_id) was dropped once engagement
// (#349) and consent (#350) released their Core reads. The link is now
// CLUSTER-ONLY (the PERSON_CLUSTER pointer in identity_index). The former Core
// guard (Talent.findTalentById → core_talent_not_found) is gone; guard-4 is now
// the cluster-exists check. cluster_id is a cross-tenant id, read/written
// server-side only — the link VIEW exposes only a boolean is_linked.
//
// === Why this lives in a dedicated service (not the controller, not
//     the repository) ===
//
// - Controller is HTTP-shaped (DTOs, guards) — keeping the cross-lib
//   orchestration out of it preserves the thin-controller pattern.
// - TalentRecordRepository is data-only (row reads / writes) — pulling
//   a cross-lib repo dependency into it would conflate orchestration
//   with data access.
// - A dedicated service fits the in-tenant gate + a column write.

@Injectable()
export class TalentLinkService {
  private readonly logger = new Logger(TalentLinkService.name);

  constructor(
    private readonly talentRecordRepo: TalentRecordRepository,
    // The PII-free cross-tenant resolution index, for the cluster_id link +
    // its cluster-exists validation (guard-4).
    private readonly identityIndex: IdentityIndexRepository,
  ) {}

  /**
   * Get the current link state for a TalentRecord.
   * Tenant-scoped read. is_linked reflects whether a PERSON_CLUSTER is set.
   */
  async getLink(args: {
    tenant_id: string;
    talent_record_id: string;
    requestId: string;
  }): Promise<TalentLinkView> {
    // Existence/404 gate.
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
    // Server-only link-state read for cluster_id.
    const link = await this.talentRecordRepo.findLinkState({
      tenant_id: args.tenant_id,
      id: args.talent_record_id,
    });
    return {
      talent_record_id: record.id,
      is_linked: link !== null && link.cluster_id !== null,
    };
  }

  /**
   * Associate (link) the TalentRecord with a given PERSON_CLUSTER.
   *
   * SACRED BOUNDARIES:
   *   - LINK-NOT-CREATE — never mints an identity.
   *   - ASSOCIATE-NOT-RESOLVE — cluster_id is an explicit input.
   *
   * Validation (in order):
   *   1. The TalentRecord exists in the requesting tenant (else 404).
   *   2. The PERSON_CLUSTER exists in identity_index (else 422,
   *      details.reason='cluster_not_found').
   *   3. setLink writes the cluster_id column (tenant-scoped UPDATE).
   *
   * Idempotent: linking to the same cluster again is a no-op write that
   * succeeds. Re-linking to a DIFFERENT cluster requires unlink first
   * (defensive — recruiters should make the change explicit; the
   * service detects this and refuses with a clear message).
   */
  async link(args: {
    tenant_id: string;
    talent_record_id: string;
    cluster_id: string;
    requestId: string;
  }): Promise<TalentLinkView> {
    // Existence/404 gate.
    const existingRecord = await this.talentRecordRepo.findById({
      tenant_id: args.tenant_id,
      id: args.talent_record_id,
    });
    if (existingRecord === null) {
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
    // Server-only link-state read for the current cluster_id.
    const existing = await this.talentRecordRepo.findLinkState({
      tenant_id: args.tenant_id,
      id: args.talent_record_id,
    });
    // Idempotency: already linked to the same cluster → return unchanged.
    if (existing !== null && existing.cluster_id === args.cluster_id) {
      this.logger.log({
        event: 'talent_link_noop_same_id',
        tenant_id: args.tenant_id,
        talent_record_id: args.talent_record_id,
      });
      return {
        talent_record_id: existingRecord.id,
        is_linked: true,
      };
    }
    // Refuse silent re-link to a DIFFERENT cluster — the recruiter must
    // unlink first. This avoids accidental rewrites masking an
    // identity confusion.
    if (
      existing !== null &&
      existing.cluster_id !== null &&
      existing.cluster_id !== args.cluster_id
    ) {
      throw new AramoError(
        'TALENT_LINK_INVALID',
        'TalentRecord is already linked to a different PERSON_CLUSTER; unlink first',
        422,
        {
          requestId: args.requestId,
          details: {
            id: args.talent_record_id,
            reason: 'already_linked_to_different_id',
          },
        },
      );
    }
    // === Guard-4: the PERSON_CLUSTER must exist in the PII-free
    // identity_index (cluster-exists validation). ===
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
            reason: 'cluster_not_found',
          },
        },
      );
    }
    // === Column write (tenant-scoped). ===
    const updated = await this.talentRecordRepo.setLink({
      tenant_id: args.tenant_id,
      id: args.talent_record_id,
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
    });
    return {
      talent_record_id: updated.id,
      is_linked: updated.cluster_id !== null,
    };
  }

  /**
   * Clear (unlink) the TalentRecord's PERSON_CLUSTER reference.
   * Tenant-scoped. Idempotent: unlinking an already-unlinked record
   * is a no-op.
   */
  async unlink(args: {
    tenant_id: string;
    talent_record_id: string;
    requestId: string;
  }): Promise<TalentLinkView> {
    // Existence/404 gate.
    const existingRecord = await this.talentRecordRepo.findById({
      tenant_id: args.tenant_id,
      id: args.talent_record_id,
    });
    if (existingRecord === null) {
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
    // Server-only link-state read for the current cluster_id.
    const existing = await this.talentRecordRepo.findLinkState({
      tenant_id: args.tenant_id,
      id: args.talent_record_id,
    });
    if (existing === null || existing.cluster_id === null) {
      // Already unlinked — idempotent no-op.
      return {
        talent_record_id: existingRecord.id,
        is_linked: false,
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
    });
    return {
      talent_record_id: updated.id,
      is_linked: false,
    };
  }
}
