import { Injectable } from '@nestjs/common';

import { normalizeSkillName } from './normalize-skill-name.js';
import { uniqueViolationOn } from './prisma-error.js';
import { PrismaService } from './prisma/prisma.service.js';
import type { SkillActor } from './skill.repository.js';
import {
  SkillAliasRepository,
  type SkillAliasRow,
  type SkillAliasType,
} from './skill-alias.repository.js';
import {
  SkillRelationshipRepository,
  type SkillRelationshipRow,
} from './skill-relationship.repository.js';
import {
  SkillGovernanceProposalRepository,
  type CreateProposalInput,
  type SkillGovernanceProposalRow,
  type ProposalStatus,
} from './skill-governance-proposal.repository.js';
import {
  directionalityOf,
  isSymmetric,
  isRelationshipType,
  isRelationshipSource,
} from './relationship-vocab.js';

// SKILL-TAX-1F-B2 — the human-ratification governance service for AI proposals.
//
// A proposal is NEVER canonical truth: creation writes a PENDING row only (zero
// canonical mutation). Acceptance is the single governed step that turns a
// proposal into canonical registry state, and it REUSES the canonical registry
// write primitives (addAliasWithin / addRelationshipWithin) inside ONE
// skills_taxonomy transaction — there is no API-specific alias/relationship
// writer, so acceptance and the direct mutation paths share exactly one canonical
// writer (row + audit + any correction task). Rejection is terminal.
//
// Atomicity/concurrency: accept() opens one interactive transaction, takes a
// row-level FOR UPDATE lock on the proposal, checks PENDING, performs the canonical
// write on the SAME tx client, then flips the proposal to ACCEPTED under a
// status='PENDING' CAS guard. The lock serializes concurrent accept/reject on the
// same id; the CAS is the belt-and-suspenders terminal-once invariant. A non-PENDING
// proposal fails with a conflict (→ 409 at the HTTP boundary) and mutates nothing.
//
// This service performs NO downstream repoint/reconcile — the alias write's
// SkillCorrectionTask (emitted inside addAliasWithin) is drained by the B1
// processor. B2 owns zero propagation logic.

export class ProposalNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Skill governance proposal not found: ${id}`);
    this.name = 'ProposalNotFoundError';
  }
}

// Not PENDING — already ACCEPTED/REJECTED (terminal). 409 at the boundary.
export class ProposalNotPendingError extends Error {
  constructor(
    public readonly id: string,
    public readonly status: ProposalStatus,
  ) {
    super(`Skill governance proposal ${id} is not PENDING (status=${status})`);
    this.name = 'ProposalNotPendingError';
  }
}

// The stored payload does not carry a valid spec for its proposal_type.
export class ProposalPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalPayloadError';
  }
}

// Acceptance would violate a canonical uniqueness constraint (e.g. the alias
// surface already exists). Surfaced as a conflict at the boundary.
export class ProposalApplyConflictError extends Error {
  constructor(
    public readonly constraint: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProposalApplyConflictError';
  }
}

const ALIAS_TYPES: readonly SkillAliasType[] = [
  'ABBREVIATION',
  'COMMON_NAME',
  'LEGACY_NAME',
  'VENDOR_VARIANT',
  'SPELLING_VARIANT',
];
function isAliasType(v: unknown): v is SkillAliasType {
  return typeof v === 'string' && (ALIAS_TYPES as readonly string[]).includes(v);
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new ProposalPayloadError(`proposal payload missing required string "${key}"`);
  }
  return v;
}

@Injectable()
export class SkillGovernanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly proposals: SkillGovernanceProposalRepository,
    private readonly aliases: SkillAliasRepository,
    private readonly relationships: SkillRelationshipRepository,
  ) {}

  // ---- Proposal creation / reads (no canonical mutation) -----------------

  // AI (or any) proposal — PENDING only, zero canonical mutation.
  async createProposal(input: CreateProposalInput): Promise<SkillGovernanceProposalRow> {
    return this.proposals.create(input);
  }

  async getProposal(id: string): Promise<SkillGovernanceProposalRow | null> {
    return this.proposals.findById(id);
  }

  async listProposals(args: { status?: ProposalStatus; limit: number }): Promise<SkillGovernanceProposalRow[]> {
    return this.proposals.list(args);
  }

  // ---- Terminal decisions ------------------------------------------------

  // Accept a PENDING proposal: one atomic skills_taxonomy transaction that reuses
  // the canonical registry write primitive and marks the proposal ACCEPTED with the
  // applied entity id. Throws ProposalNotFoundError / ProposalNotPendingError /
  // ProposalPayloadError / ProposalApplyConflictError — never partially applies.
  async accept(id: string, actor?: SkillActor): Promise<SkillGovernanceProposalRow> {
    const decidedBy = actor?.id ?? null;
    const decidedAt = new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialize concurrent decisions on this proposal (terminal-once).
        await tx.$queryRawUnsafe(
          'SELECT id FROM "skills_taxonomy"."SkillGovernanceProposal" WHERE id = $1::uuid FOR UPDATE',
          id,
        );
        const proposal = (await tx.skillGovernanceProposal.findUnique({
          where: { id },
        })) as SkillGovernanceProposalRow | null;
        if (proposal === null) throw new ProposalNotFoundError(id);
        if (proposal.status !== 'PENDING') {
          throw new ProposalNotPendingError(id, proposal.status);
        }

        const payload = (proposal.payload ?? {}) as Record<string, unknown>;
        const appliedEntityId = await this.applyWithin(tx, proposal.proposal_type, payload, actor);

        // Terminal CAS — a concurrent decision that beat us leaves count=0; throw to
        // roll back the canonical write we just made (never double-apply).
        const { count } = await tx.skillGovernanceProposal.updateMany({
          where: { id, status: 'PENDING' },
          data: {
            status: 'ACCEPTED',
            decided_by: decidedBy,
            decided_at: decidedAt,
            applied_entity_id: appliedEntityId,
          },
        });
        if (count === 0) throw new ProposalNotPendingError(id, 'ACCEPTED');

        const updated = (await tx.skillGovernanceProposal.findUnique({
          where: { id },
        })) as SkillGovernanceProposalRow;
        return updated;
      });
    } catch (e) {
      // Translate a canonical uniqueness violation surfaced by the tx into a
      // governance conflict (the proposal stays PENDING — the tx rolled back).
      if (uniqueViolationOn(e, 'normalized_alias')) {
        throw new ProposalApplyConflictError('normalized_alias', 'alias surface already exists');
      }
      if (uniqueViolationOn(e, 'source_target_type')) {
        throw new ProposalApplyConflictError('source_target_type', 'relationship already exists');
      }
      throw e;
    }
  }

  // Reject a PENDING proposal (terminal). Reuses the repository CAS — returns the
  // updated row, or throws ProposalNotFound/NotPending when it was not PENDING.
  async reject(id: string, reason: string | null, actor?: SkillActor): Promise<SkillGovernanceProposalRow> {
    const decidedBy = actor?.id ?? null;
    const rejected = await this.proposals.reject(id, decidedBy, reason, new Date());
    if (rejected !== null) return rejected;
    // CAS missed — distinguish not-found (404) from already-terminal (409).
    const existing = await this.proposals.findById(id);
    if (existing === null) throw new ProposalNotFoundError(id);
    throw new ProposalNotPendingError(id, existing.status);
  }

  // Dispatch the canonical write for an accepted proposal onto the caller's tx,
  // reusing the shared registry write primitive. Returns the applied entity id.
  private async applyWithin(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    proposalType: string,
    payload: Record<string, unknown>,
    actor?: SkillActor,
  ): Promise<string> {
    if (proposalType === 'ALIAS') {
      const alias = requireString(payload, 'alias').trim();
      const skillId = requireString(payload, 'skill_id');
      const aliasType = payload['alias_type'];
      if (!isAliasType(aliasType)) {
        throw new ProposalPayloadError(`proposal payload has invalid alias_type "${String(aliasType)}"`);
      }
      const row: SkillAliasRow = await this.aliases.addAliasWithin(tx, {
        skill_id: skillId,
        alias,
        normalized_alias: normalizeSkillName(alias),
        alias_type: aliasType,
        actor,
      });
      return row.id;
    }
    if (proposalType === 'RELATIONSHIP') {
      const sourceSkillId = requireString(payload, 'source_skill_id');
      const targetSkillId = requireString(payload, 'target_skill_id');
      const relationshipType = payload['relationship_type'];
      const source = payload['source'];
      if (!isRelationshipType(relationshipType)) {
        throw new ProposalPayloadError(
          `proposal payload has invalid relationship_type "${String(relationshipType)}"`,
        );
      }
      if (!isRelationshipSource(source)) {
        throw new ProposalPayloadError(`proposal payload has invalid source "${String(source)}"`);
      }
      if (sourceSkillId === targetSkillId) {
        throw new ProposalPayloadError('a skill cannot have a relationship to itself');
      }
      const sourceRefRaw = payload['source_ref'];
      const sourceRef = typeof sourceRefRaw === 'string' ? sourceRefRaw : null;
      // Canonical orientation for symmetric edges (smaller uuid as source) — the
      // same pure rule the registry service applies; the WRITE itself is the shared
      // repo primitive, not duplicated here.
      let src: string = sourceSkillId;
      let tgt: string = targetSkillId;
      if (isSymmetric(relationshipType) && src > tgt) {
        [src, tgt] = [tgt, src];
      }
      const row: SkillRelationshipRow = await this.relationships.addRelationshipWithin(tx, {
        source_skill_id: src,
        target_skill_id: tgt,
        relationship_type: relationshipType,
        directionality: directionalityOf(relationshipType),
        source,
        source_ref: sourceRef,
        actor,
      });
      return row.id;
    }
    throw new ProposalPayloadError(`unsupported proposal_type "${proposalType}"`);
  }
}
