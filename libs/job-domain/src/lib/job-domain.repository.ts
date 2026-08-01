import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// Repository for the Job-domain entities (M3 PR-4).
//
// Surface scope (closed, per the PR-1 entity-foundation precedent):
//   - createJob / findJobById
//   - createGoldenProfile / findGoldenProfileById
//
// T1-a retired the Requisition surface (createRequisition /
// findRequisitionById / findActiveRequisitionByJobId) and the model itself —
// the mirror's `state` had no updater, so a requisition closed in the ATS still
// read active through it. The ATS requisition (requisition.Requisition) is now
// the sole lifecycle authority, read via the RequisitionStateReader port. Job +
// GoldenProfile stay — the live examine-flow spine.
//
// Read-and-create only. No update / delete / list / filter methods are
// exposed — those are speculative until a consumer (PR-5 / PR-6 / PR-7)
// arrives with a concrete read pattern. PR-4 is an entity foundation,
// not a service layer.
//
// Cross-schema rule (Architecture v2.1 §7.3 — also the PR-4 directive §4.1
// anchor 5): every `*_id` field on every entity is a plain UUID column with
// no foreign key. The repository accepts the UUIDs verbatim and persists
// them without referential validation; the application layer is
// responsible for the referenced values being correct, and the weekly
// cross-schema consistency check job (Architecture §9) audits orphans.
//
// Json columns (`skills`, `experience`, `constraints` on GoldenProfile)
// carry shape that Group 3 will define. The repository accepts any
// JSON-serialisable value (`unknown`) and forwards it to Prisma opaquely
// — the same opaque-Json pattern PR-1's ExaminationRepository uses for
// its nine analytical fields.

// ---- Job ---------------------------------------------------------------

export interface CreateJobInput {
  id: string;
  tenant_id: string;
}

export interface JobRow {
  id: string;
  tenant_id: string;
}

// ---- GoldenProfile -----------------------------------------------------

type JsonInput = unknown;

export interface CreateGoldenProfileInput {
  id: string;
  tenant_id: string;
  job_id: string;
  skills: JsonInput;
  experience: JsonInput;
  constraints: JsonInput;
  critical_skills: readonly string[];
}

export interface GoldenProfileRow {
  id: string;
  tenant_id: string;
  job_id: string;
  skills: unknown;
  experience: unknown;
  constraints: unknown;
  critical_skills: string[];
}

@Injectable()
export class JobDomainRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Job -------------------------------------------------------------

  async createJob(input: CreateJobInput): Promise<JobRow> {
    const created = await this.prisma.job.create({
      data: {
        id: input.id,
        tenant_id: input.tenant_id,
      },
    });
    return created as JobRow;
  }

  async findJobById(id: string): Promise<JobRow | null> {
    const row = await this.prisma.job.findUnique({ where: { id } });
    return (row as JobRow | null) ?? null;
  }

  // ---- GoldenProfile --------------------------------------------------

  async createGoldenProfile(input: CreateGoldenProfileInput): Promise<GoldenProfileRow> {
    const created = await this.prisma.goldenProfile.create({
      data: {
        id: input.id,
        tenant_id: input.tenant_id,
        job_id: input.job_id,
        skills: input.skills as never,
        experience: input.experience as never,
        constraints: input.constraints as never,
        critical_skills: [...input.critical_skills],
      },
    });
    return created as GoldenProfileRow;
  }

  async findGoldenProfileById(id: string): Promise<GoldenProfileRow | null> {
    const row = await this.prisma.goldenProfile.findUnique({ where: { id } });
    return (row as GoldenProfileRow | null) ?? null;
  }

  // Job-Module LB-2 — idempotent re-generation: update an existing
  // GoldenProfile's content in place (re-confirming a brief overwrites the
  // captured content, never mints a duplicate). Tenant-scoped via the
  // updateMany predicate so a cross-tenant id is a no-op (count 0). The
  // content columns only (skills / experience / constraints / critical_
  // skills); id / tenant_id / job_id are immutable.
  async updateGoldenProfile(input: {
    id: string;
    tenant_id: string;
    skills: unknown;
    experience: unknown;
    constraints: unknown;
    critical_skills: readonly string[];
  }): Promise<GoldenProfileRow | null> {
    const result = await this.prisma.goldenProfile.updateMany({
      where: { id: input.id, tenant_id: input.tenant_id },
      data: {
        skills: input.skills as never,
        experience: input.experience as never,
        constraints: input.constraints as never,
        critical_skills: [...input.critical_skills],
      },
    });
    if (result.count === 0) return null;
    return this.findGoldenProfileById(input.id);
  }

}
