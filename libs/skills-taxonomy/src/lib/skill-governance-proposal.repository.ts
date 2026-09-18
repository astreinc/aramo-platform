import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';

// SKILL-TAX-1F-B2 — persistence for the AI proposal-only substrate
// (SkillGovernanceProposal). A proposal is NEVER canonical truth: creation only
// writes a PENDING row (zero canonical mutation). The accept/reject decision is a
// separate governed step (SkillGovernanceService), where acceptance reuses the
// canonical registry write primitives inside one taxonomy transaction. This
// repository owns plain persistence + the CAS-style terminal status transition.

export type ProposalType = 'ALIAS' | 'RELATIONSHIP';
export type ProposalSource = 'AI_RECOMMENDED';
export type ProposalStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

export interface SkillGovernanceProposalRow {
  id: string;
  proposal_type: ProposalType;
  source: ProposalSource;
  status: ProposalStatus;
  payload: unknown;
  proposed_by: string | null;
  proposed_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  applied_entity_id: string | null;
}

export interface CreateProposalInput {
  proposal_type: ProposalType;
  source: ProposalSource;
  payload: Record<string, unknown>;
  proposed_by: string | null;
}

@Injectable()
export class SkillGovernanceProposalRepository {
  constructor(private readonly prisma: PrismaService) {}

  // AI (or any) proposal creation — PENDING only, zero canonical mutation.
  async create(input: CreateProposalInput): Promise<SkillGovernanceProposalRow> {
    const row = await this.prisma.skillGovernanceProposal.create({
      data: {
        id: uuidv7(),
        proposal_type: input.proposal_type,
        source: input.source,
        status: 'PENDING',
        payload: input.payload as never,
        proposed_by: input.proposed_by,
      },
    });
    return row as SkillGovernanceProposalRow;
  }

  async findById(id: string): Promise<SkillGovernanceProposalRow | null> {
    const row = await this.prisma.skillGovernanceProposal.findUnique({ where: { id } });
    return (row as SkillGovernanceProposalRow | null) ?? null;
  }

  // Keyset-friendly list (newest first); optional status filter.
  async list(args: { status?: ProposalStatus; limit: number }): Promise<SkillGovernanceProposalRow[]> {
    const rows = await this.prisma.skillGovernanceProposal.findMany({
      ...(args.status !== undefined ? { where: { status: args.status } } : {}),
      orderBy: [{ proposed_at: 'desc' }, { id: 'desc' }],
      take: args.limit,
    });
    return rows as SkillGovernanceProposalRow[];
  }

  // Terminal REJECTED transition — CAS on status='PENDING' so a concurrent decide
  // cannot double-transition. Returns null if the row was not PENDING (→ 409 caller).
  async reject(
    id: string,
    deciderId: string | null,
    reason: string | null,
    decidedAt: Date,
  ): Promise<SkillGovernanceProposalRow | null> {
    const { count } = await this.prisma.skillGovernanceProposal.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'REJECTED', decided_by: deciderId, decided_at: decidedAt, decision_reason: reason },
    });
    if (count === 0) return null;
    return this.findById(id);
  }
}
