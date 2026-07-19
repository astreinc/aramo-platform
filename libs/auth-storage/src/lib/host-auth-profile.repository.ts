import { Injectable } from '@nestjs/common';

import type { HostAuthProfileDto, HostClass } from './dto/host-auth-profile.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// Auth-Decoupling PR-1 — data access for the host auth-profile registry.
// Internal (not exported): HostAuthProfileStore is the public read surface,
// consistent with the RefreshToken repo/service split.

interface RawHostAuthProfileRow {
  id: string;
  host_class: string;
  host_pattern: string;
  pool_id: string;
  client_id: string;
  issuer: string;
  domain: string;
  default_idp: string | null;
  post_login_path: string;
  signout_path: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function toDto(row: RawHostAuthProfileRow): HostAuthProfileDto {
  return {
    id: row.id,
    // host_class is a closed-vocab column written only by the seed; the cast is
    // safe because no other writer exists (PR-1 has no write API).
    host_class: row.host_class as HostClass,
    host_pattern: row.host_pattern,
    pool_id: row.pool_id,
    client_id: row.client_id,
    issuer: row.issuer,
    domain: row.domain,
    default_idp: row.default_idp,
    post_login_path: row.post_login_path,
    signout_path: row.signout_path,
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

@Injectable()
export class HostAuthProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  // All active rows. The registry is at most three rows (one per class), so a
  // full active read is trivial and lets the classifier index by class.
  async findAllActive(): Promise<HostAuthProfileDto[]> {
    const rows = (await this.prisma.hostAuthProfile.findMany({
      where: { is_active: true },
    })) as RawHostAuthProfileRow[];
    return rows.map(toDto);
  }
}
