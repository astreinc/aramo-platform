import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// Repository for the RawPayloadReference model. PR-12 scope: payload
// writes + dedup queries. No merge, no resolve, no canonicalize
// (per directive §4.4 + §5).

export interface CreateRawPayloadInput {
  id?: string;
  tenant_id: string;
  source: string;
  storage_ref: string;
  sha256: string;
  content_type: string;
  captured_at: Date;
  verified_email: string | null;
  profile_url: string | null;
  // PR-13: optional raw skill surface forms (Plan §3 M2 Track A:
  // "raw forms stored, canonicalization deferred"). Opaque strings.
  skill_surface_forms?: string[] | null;
}

export interface RawPayloadRow {
  id: string;
  tenant_id: string;
  source: string;
  storage_ref: string;
  sha256: string;
  content_type: string;
  captured_at: Date;
  verified_email: string | null;
  profile_url: string | null;
  // PR-13: nullable Json column (per Prisma `Json?`) — at runtime
  // Prisma surfaces this as `unknown | null` since Json columns
  // accept arbitrary shapes. The wire-level shape is string[]; the
  // service layer narrows.
  skill_surface_forms: unknown;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class IngestionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createPayload(input: CreateRawPayloadInput): Promise<RawPayloadRow> {
    // skill_surface_forms is a Prisma Json? column. Pass the array
    // value through directly when supplied; omit the field when not
    // (Prisma defaults to NULL for the column). null is intentionally
    // not passed — Prisma's NullableJsonNullValueInput requires the
    // `Prisma.DbNull` sentinel for explicit JSON-null writes, and PR-13
    // never needs explicit-null semantics (absence === NULL is fine).
    const skillSurfaceField =
      input.skill_surface_forms !== undefined &&
      input.skill_surface_forms !== null
        ? { skill_surface_forms: input.skill_surface_forms }
        : {};
    const row = await this.prisma.rawPayloadReference.create({
      data: {
        ...(input.id !== undefined ? { id: input.id } : {}),
        tenant_id: input.tenant_id,
        source: input.source,
        storage_ref: input.storage_ref,
        sha256: input.sha256,
        content_type: input.content_type,
        captured_at: input.captured_at,
        verified_email: input.verified_email,
        profile_url: input.profile_url,
        ...skillSurfaceField,
      },
    });
    return row as RawPayloadRow;
  }

  // Content-addressed lookup: a (tenant_id, sha256) hit means the same
  // payload bytes were already ingested in this tenant.
  async findBySha256(args: {
    tenant_id: string;
    sha256: string;
  }): Promise<RawPayloadRow | null> {
    const row = await this.prisma.rawPayloadReference.findUnique({
      where: {
        tenant_id_sha256: {
          tenant_id: args.tenant_id,
          sha256: args.sha256,
        },
      },
    });
    return row === null ? null : (row as RawPayloadRow);
  }

  // Dedup query — earliest matching row by verified_email within a
  // tenant. Returns null when no prior match exists.
  async findByVerifiedEmail(args: {
    tenant_id: string;
    verified_email: string;
  }): Promise<RawPayloadRow | null> {
    const row = await this.prisma.rawPayloadReference.findFirst({
      where: {
        tenant_id: args.tenant_id,
        verified_email: args.verified_email,
      },
      orderBy: { created_at: 'asc' },
    });
    return row === null ? null : (row as RawPayloadRow);
  }

  // Dedup query — earliest matching row by profile_url within a tenant.
  async findByProfileUrl(args: {
    tenant_id: string;
    profile_url: string;
  }): Promise<RawPayloadRow | null> {
    const row = await this.prisma.rawPayloadReference.findFirst({
      where: {
        tenant_id: args.tenant_id,
        profile_url: args.profile_url,
      },
      orderBy: { created_at: 'asc' },
    });
    return row === null ? null : (row as RawPayloadRow);
  }

  async findById(args: { id: string }): Promise<RawPayloadRow | null> {
    const row = await this.prisma.rawPayloadReference.findUnique({
      where: { id: args.id },
    });
    return row === null ? null : (row as RawPayloadRow);
  }
}
