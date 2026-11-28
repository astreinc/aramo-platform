import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

// SMS-CONSENT-1 (LOCKED 2026-11-28) — persistence for consent to texts (migration
// 20261128100000_sign_sms_consent_1):
//   - SignSmsCertification  the organization's certification (append-only: insert, then at most
//                           one withdrawal; the current one is the latest row not withdrawn);
//   - SignUserSmsConsent    one row per user: the user's own number, its verification and the
//                           separate consent (revocable);
//   - SignUserSmsCode       the codes that verify that number (only the SHA-256 of a code).
// The rules (wording versions, availability, plan) live in sign-service; this file only stores.

export interface SmsCertificationRow {
  id: string;
  tenant_id: string;
  certified_by_user_id: string;
  certified_at: Date;
  wording_version: string;
  withdrawn_at: Date | null;
  withdrawn_by_user_id: string | null;
}

export interface UserSmsConsentRow {
  user_id: string;
  phone_e164: string;
  phone_verified_at: Date | null;
  consented_at: Date | null;
  consent_wording_version: string | null;
  consent_channel: string | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type UserSmsCodeStatus = 'ACTIVE' | 'VERIFIED' | 'EXPIRED' | 'LOCKED' | 'SUPERSEDED';

export interface UserSmsCodeRow {
  id: string;
  user_id: string;
  phone_hash: string;
  code_hash: string;
  status: string;
  attempts: number;
  expires_at: Date;
  created_at: Date;
  verified_at: Date | null;
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === 'P2002';
}

@Injectable()
export class SignSmsConsentRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── The organization certification ────────────────────────────────────────
  async currentCertification(tenant_id: string): Promise<SmsCertificationRow | null> {
    return this.prisma.signSmsCertification.findFirst({ where: { tenant_id, withdrawn_at: null }, orderBy: { certified_at: 'desc' } });
  }

  /**
   * Record a certification under `wording_version`. A current certification under the same
   * version is kept (idempotent); one under another version is withdrawn by the certifier first.
   */
  async certify(input: { id: string; tenant_id: string; user_id: string; wording_version: string; now: Date }): Promise<SmsCertificationRow> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const current = await tx.signSmsCertification.findFirst({ where: { tenant_id: input.tenant_id, withdrawn_at: null } });
        if (current !== null && current.wording_version === input.wording_version) return current;
        if (current !== null) {
          await tx.signSmsCertification.update({ where: { id: current.id }, data: { withdrawn_at: input.now, withdrawn_by_user_id: input.user_id } });
        }
        return tx.signSmsCertification.create({
          data: { id: input.id, tenant_id: input.tenant_id, certified_by_user_id: input.user_id, certified_at: input.now, wording_version: input.wording_version },
        });
      });
    } catch (e) {
      // A concurrent certify won the one-current-row index: answer with that row.
      if (!isUniqueViolation(e)) throw e;
      const current = await this.currentCertification(input.tenant_id);
      if (current === null) throw e;
      return current;
    }
  }

  /** Withdraw the current certification. Returns the number of rows withdrawn (0 or 1). */
  async withdraw(tenant_id: string, user_id: string, now: Date): Promise<number> {
    const r = await this.prisma.signSmsCertification.updateMany({ where: { tenant_id, withdrawn_at: null }, data: { withdrawn_at: now, withdrawn_by_user_id: user_id } });
    return r.count;
  }

  // ── A user's own number and consent ───────────────────────────────────────
  async consentOf(user_id: string): Promise<UserSmsConsentRow | null> {
    return this.prisma.signUserSmsConsent.findUnique({ where: { user_id } });
  }

  /** Put a number on file. A different number starts unverified and without consent. */
  async setPhone(user_id: string, phone_e164: string, now: Date): Promise<UserSmsConsentRow> {
    const existing = await this.consentOf(user_id);
    if (existing !== null && existing.phone_e164 === phone_e164) return existing;
    const fresh = { phone_e164, phone_verified_at: null, consented_at: null, consent_wording_version: null, consent_channel: null, revoked_at: null, updated_at: now };
    return this.prisma.signUserSmsConsent.upsert({
      where: { user_id },
      create: { user_id, ...fresh, created_at: now },
      update: fresh,
    });
  }

  /** Mark the number verified, only while it is still the number on file. */
  async markVerified(user_id: string, phone_e164: string, now: Date): Promise<boolean> {
    const r = await this.prisma.signUserSmsConsent.updateMany({ where: { user_id, phone_e164 }, data: { phone_verified_at: now, updated_at: now } });
    return r.count === 1;
  }

  /** Give (or renew) the consent on a verified number. */
  async giveConsent(user_id: string, input: { wording_version: string; channel: string; now: Date }): Promise<boolean> {
    const r = await this.prisma.signUserSmsConsent.updateMany({
      where: { user_id, phone_verified_at: { not: null } },
      data: { consented_at: input.now, consent_wording_version: input.wording_version, consent_channel: input.channel, revoked_at: null, updated_at: input.now },
    });
    return r.count === 1;
  }

  /** Turn the consent off (the number stays on file). */
  async revokeConsent(user_id: string, now: Date): Promise<void> {
    await this.prisma.signUserSmsConsent.updateMany({ where: { user_id, consented_at: { not: null }, revoked_at: null }, data: { revoked_at: now, updated_at: now } });
  }

  /** STOP from a number: every consent on that number is revoked. Returns how many. */
  async revokeConsentByPhone(phone_e164: string, now: Date): Promise<number> {
    const r = await this.prisma.signUserSmsConsent.updateMany({ where: { phone_e164, consented_at: { not: null }, revoked_at: null }, data: { revoked_at: now, updated_at: now } });
    return r.count;
  }

  /** Remove the number, the consent and every pending code. */
  async removeConsent(user_id: string): Promise<void> {
    await this.prisma.$transaction([this.prisma.signUserSmsCode.deleteMany({ where: { user_id } }), this.prisma.signUserSmsConsent.deleteMany({ where: { user_id } })]);
  }

  // ── The codes that verify a user's number ─────────────────────────────────
  async codeHistory(user_id: string, since: Date): Promise<UserSmsCodeRow[]> {
    return this.prisma.signUserSmsCode.findMany({ where: { user_id, created_at: { gte: since } }, orderBy: { created_at: 'desc' } });
  }

  async activeCode(user_id: string): Promise<UserSmsCodeRow | null> {
    return this.prisma.signUserSmsCode.findFirst({ where: { user_id, status: 'ACTIVE' }, orderBy: { created_at: 'desc' } });
  }

  /** A new code supersedes every ACTIVE one of the user. */
  async createCode(input: { id: string; user_id: string; phone_hash: string; code_hash: string; expires_at: Date; now: Date }): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.signUserSmsCode.updateMany({ where: { user_id: input.user_id, status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } }),
      this.prisma.signUserSmsCode.create({
        data: { id: input.id, user_id: input.user_id, phone_hash: input.phone_hash, code_hash: input.code_hash, expires_at: input.expires_at, created_at: input.now },
      }),
    ]);
  }

  /** A code that could not be sent does not count. */
  async withdrawCode(id: string): Promise<void> {
    await this.prisma.signUserSmsCode.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
  }

  /**
   * Record one check of an ACTIVE code (compare-and-set on the attempt count, so two concurrent
   * checks cannot both pass). False when the code changed meanwhile.
   */
  async recordCodeAttempt(input: { id: string; expected_attempts: number; outcome: 'VERIFIED' | 'MISMATCH' | 'LOCKED' | 'EXPIRED'; now: Date }): Promise<boolean> {
    const status: UserSmsCodeStatus = input.outcome === 'MISMATCH' ? 'ACTIVE' : input.outcome;
    const r = await this.prisma.signUserSmsCode.updateMany({
      where: { id: input.id, status: 'ACTIVE', ...(input.outcome === 'EXPIRED' ? {} : { attempts: input.expected_attempts }) },
      data: {
        status,
        ...(input.outcome === 'EXPIRED' ? {} : { attempts: input.expected_attempts + 1 }),
        ...(input.outcome === 'VERIFIED' ? { verified_at: input.now } : {}),
      },
    });
    return r.count === 1;
  }

  // ── The signer an SMS goes to (R-5) ───────────────────────────────────────
  async signerEmail(tenant_id: string, signer_id: string): Promise<string | null> {
    const s = await this.prisma.signer.findFirst({ where: { id: signer_id, tenant_id }, select: { email: true } });
    return s?.email ?? null;
  }
}
