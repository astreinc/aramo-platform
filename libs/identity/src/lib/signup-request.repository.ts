import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';

// Aramo Sign launch — the self-service signup request store (provisioning
// integrity). Rows hold only the sha256 of the emailed token. The status machine:
//   PENDING ─claim→ PROVISIONING ─→ PROVISIONED
//                       └──────────→ FAILED ─claim→ PROVISIONING (retry, until expiry)
//   PENDING | FAILED ─(newer request for the same email)→ SUPERSEDED
// A claim is a compare-and-set, so two concurrent completions never provision
// twice; a PROVISIONING row whose holder died is reclaimable after STALE_MS.

export const SIGNUP_PROVISIONING_STALE_MS = 10 * 60 * 1000;

export interface SignupRequestRow {
  id: string;
  email: string;
  organization_name: string;
  display_name: string | null;
  product: string;
  expires_at: Date;
  status: string;
  tenant_id: string | null;
  owner_user_id: string | null;
  failure_code: string | null;
  attempts: number;
  terms_ref: string | null;
  created_at: Date;
}

@Injectable()
export class SignupRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  async countSince(email: string, since: Date): Promise<number> {
    return this.prisma.signupRequest.count({ where: { email, created_at: { gte: since } } });
  }

  async latestForEmail(email: string): Promise<SignupRequestRow | null> {
    return this.prisma.signupRequest.findFirst({ where: { email }, orderBy: { created_at: 'desc' } });
  }

  /** A new request supersedes the email's open (PENDING / FAILED) ones. */
  async create(input: {
    email: string;
    organization_name: string;
    display_name: string | null;
    token_hash: string;
    expires_at: Date;
    terms_ref: string | null;
    now: Date;
  }): Promise<SignupRequestRow> {
    return this.prisma.$transaction(async (tx) => {
      await tx.signupRequest.updateMany({
        where: { email: input.email, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'SUPERSEDED', updated_at: input.now },
      });
      return tx.signupRequest.create({
        data: {
          id: uuidv7(),
          email: input.email,
          organization_name: input.organization_name,
          display_name: input.display_name,
          token_hash: input.token_hash,
          expires_at: input.expires_at,
          terms_ref: input.terms_ref,
          created_at: input.now,
          updated_at: input.now,
        },
      });
    });
  }

  async findByTokenHash(token_hash: string): Promise<SignupRequestRow | null> {
    return this.prisma.signupRequest.findUnique({ where: { token_hash } });
  }

  /** CAS: take the request for provisioning. False when someone else holds it or it is done/expired. */
  async claim(id: string, now: Date): Promise<boolean> {
    const stale = new Date(now.getTime() - SIGNUP_PROVISIONING_STALE_MS);
    const n = await this.prisma.signupRequest.updateMany({
      where: {
        id,
        expires_at: { gt: now },
        OR: [{ status: { in: ['PENDING', 'FAILED'] } }, { status: 'PROVISIONING', updated_at: { lt: stale } }],
      },
      data: { status: 'PROVISIONING', attempts: { increment: 1 }, failure_code: null, updated_at: now },
    });
    if (n.count === 1) {
      await this.prisma.signupRequest.updateMany({ where: { id, verified_at: null }, data: { verified_at: now } });
    }
    return n.count === 1;
  }

  async markProvisioned(id: string, tenant_id: string, owner_user_id: string, now: Date): Promise<void> {
    await this.prisma.signupRequest.update({
      where: { id },
      data: { status: 'PROVISIONED', tenant_id, owner_user_id, failure_code: null, updated_at: now },
    });
  }

  async markFailed(id: string, failure_code: string, now: Date): Promise<void> {
    await this.prisma.signupRequest.updateMany({
      where: { id, status: 'PROVISIONING' },
      data: { status: 'FAILED', failure_code: failure_code.slice(0, 100), updated_at: now },
    });
  }
}
