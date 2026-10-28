import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3.2 — the Sign data of one privacy-request
// subject: the counts-only inventory and the two Sign-side reads/writes the
// execution needs beyond the existing purges.
//
//   inventory          counts only, never row contents (DATA_INVENTORY evidence)
//   revokeSignSessions every Sign native device session of (user, tenant) and every
//                      Sign refresh token (browser 'sign' and native 'sign_native')
//                      of (user, tenant) is revoked; nothing of another product is
//                      touched. Idempotent.
//   draftEnvelopeIds   the never-sent (DRAFT, not yet deleted) envelopes the user
//                      created in the tenant — deleted with their stored objects by
//                      the caller through the existing draft-delete path.
//
// The auth_storage tables live in the same database (written by auth-service); a
// database without them (an isolated Sign test database) reports null counts.

export interface SignPrivacyInventory {
  native_sessions_active: number | null;
  refresh_tokens_active: number | null;
  saved_signatures: number;
  contacts: number;
  push_devices: number;
  notifications: number;
  notification_preferences: number;
  draft_envelopes: number;
  sent_envelopes: number;
  completed_envelopes: number;
  signer_records: number;
  signer_sender_organizations: number;
}

export const SIGN_NATIVE_CONSUMER = 'sign';
export const SIGN_REFRESH_CONSUMERS = ['sign', 'sign_native'] as const;

type Count = Array<{ n: bigint | number }>;
const num = (rows: Count): number => Number(rows[0]?.n ?? 0);

@Injectable()
export class SignPrivacyRepository {
  constructor(private readonly prisma: PrismaService) {}

  private async authStoragePresent(): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ present: boolean }>>`
      SELECT to_regclass('auth_storage."NativeDeviceSession"') IS NOT NULL AND to_regclass('auth_storage."RefreshToken"') IS NOT NULL AS present`;
    return rows[0]?.present === true;
  }

  /** Counts only. `subject` may be absent (an email with no account: signer records only). */
  async inventory(input: { subject: { tenant_id: string; user_id: string } | null; email: string | null }): Promise<SignPrivacyInventory> {
    const s = input.subject;
    const auth = s !== null && (await this.authStoragePresent());
    const zero = 0;
    const [sessions, tokens] = auth && s !== null
      ? await Promise.all([
          this.prisma.$queryRaw<Count>`SELECT count(*) AS n FROM auth_storage."NativeDeviceSession" WHERE user_id = ${s.user_id}::uuid AND tenant_id = ${s.tenant_id}::uuid AND consumer_type = ${SIGN_NATIVE_CONSUMER} AND revoked_at IS NULL`,
          this.prisma.$queryRaw<Count>`SELECT count(*) AS n FROM auth_storage."RefreshToken" WHERE user_id = ${s.user_id}::uuid AND tenant_id = ${s.tenant_id}::uuid AND consumer_type IN ('sign', 'sign_native') AND revoked_at IS NULL AND expires_at > now()`,
        ])
      : [null, null];
    const owned = s === null
      ? { saved_signatures: zero, contacts: zero, push_devices: zero, notifications: zero, notification_preferences: zero, draft_envelopes: zero, sent_envelopes: zero, completed_envelopes: zero }
      : {
          saved_signatures: await this.prisma.signSavedSignature.count({ where: { tenant_id: s.tenant_id, user_id: s.user_id } }),
          contacts: await this.prisma.signContact.count({ where: { tenant_id: s.tenant_id, owner_user_id: s.user_id } }),
          push_devices: await this.prisma.signPushDevice.count({ where: { tenant_id: s.tenant_id, user_id: s.user_id } }),
          notifications: await this.prisma.signUserNotification.count({ where: { tenant_id: s.tenant_id, user_id: s.user_id } }),
          notification_preferences: await this.prisma.signNotificationPreference.count({ where: { tenant_id: s.tenant_id, user_id: s.user_id } }),
          draft_envelopes: await this.prisma.signatureEnvelope.count({ where: { tenant_id: s.tenant_id, created_by: s.user_id, status: 'DRAFT', deleted_at: null } }),
          sent_envelopes: await this.prisma.signatureEnvelope.count({ where: { tenant_id: s.tenant_id, created_by: s.user_id, status: { notIn: ['DRAFT', 'COMPLETED'] } } }),
          completed_envelopes: await this.prisma.signatureEnvelope.count({ where: { tenant_id: s.tenant_id, created_by: s.user_id, status: 'COMPLETED' } }),
        };
    let signer_records = 0;
    let signer_sender_organizations = 0;
    if (input.email !== null) {
      const email = input.email.trim().toLowerCase();
      signer_records = num(await this.prisma.$queryRaw<Count>`SELECT count(*) AS n FROM "sign"."Signer" WHERE lower(email) = ${email}`);
      signer_sender_organizations = num(await this.prisma.$queryRaw<Count>`SELECT count(DISTINCT tenant_id) AS n FROM "sign"."Signer" WHERE lower(email) = ${email}`);
    }
    return {
      native_sessions_active: sessions === null ? null : num(sessions),
      refresh_tokens_active: tokens === null ? null : num(tokens),
      ...owned,
      signer_records,
      signer_sender_organizations,
    };
  }

  /** Revokes every Sign session and Sign refresh token of (user, tenant). Idempotent; counts only. */
  async revokeSignSessions(input: { tenant_id: string; user_id: string; reason: string }): Promise<{ device_sessions_revoked: number | null; refresh_tokens_revoked: number | null }> {
    if (!(await this.authStoragePresent())) return { device_sessions_revoked: null, refresh_tokens_revoked: null };
    return this.prisma.$transaction(async (tx) => {
      const sessions = await tx.$executeRaw`
        UPDATE auth_storage."NativeDeviceSession" SET revoked_at = now(), revoke_reason = ${input.reason}
         WHERE user_id = ${input.user_id}::uuid AND tenant_id = ${input.tenant_id}::uuid AND consumer_type = ${SIGN_NATIVE_CONSUMER} AND revoked_at IS NULL`;
      const tokens = await tx.$executeRaw`
        UPDATE auth_storage."RefreshToken" SET revoked_at = now(), updated_at = now()
         WHERE user_id = ${input.user_id}::uuid AND tenant_id = ${input.tenant_id}::uuid AND consumer_type IN ('sign', 'sign_native') AND revoked_at IS NULL`;
      return { device_sessions_revoked: sessions, refresh_tokens_revoked: tokens };
    });
  }

  /** The user's never-sent drafts in the tenant (ids only). */
  async draftEnvelopeIds(input: { tenant_id: string; user_id: string }): Promise<string[]> {
    const rows = await this.prisma.signatureEnvelope.findMany({
      where: { tenant_id: input.tenant_id, created_by: input.user_id, status: 'DRAFT', deleted_at: null },
      select: { id: true },
      orderBy: { created_at: 'asc' },
    });
    return rows.map((r) => r.id);
  }
}
