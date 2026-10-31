import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, UseFilters } from '@nestjs/common';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import { ESIGN_SCOPE, EsignSenderBoundary } from '@aramo/identity';
import { RETENTION_DAYS_MAX, RETENTION_DAYS_MIN, SignPurgeRepository, isPurgeLevel, type PurgeLevel } from '@aramo/sign';

import { ESIGN_READ_SCOPE } from '../sender/sender-context.service.js';
import { SenderEnvelopeService } from '../sender/sender-envelope.service.js';

import { purgeViewOf } from './purge-view.js';
import { SignPurgeService } from './sign-purge.service.js';

// Aramo-Sign-Retention-and-Purge-DocuSign-Parity-Directive-v0_1-LOCKED (ebd41d99) — the
// sender workspace's retention and purge routes (W1, W4, W5):
//   GET  retention-policy                    any workspace reader (can_edit tells the UI)
//   PUT  retention-policy                    sign:settings:manage
//   POST envelopes/:id/delete | restore      the DocuSign "Deleted" folder for this tenant (LD-5)
//   POST envelopes/:id/purge | purge/dequeue sign:envelope:manage:all
//   POST purge/targeted                      sign:settings:manage (R-9)
// DARK: every write answers 403 ESIGN_FEATURE_NOT_AVAILABLE unless SIGN_PURGE_ENABLED=1, and
// the read reports can_edit false — nothing changes for users until the PO enables purge.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Controller('v1/sign/sender')
@UseFilters(AramoExceptionFilter)
export class SignRetentionController {
  constructor(
    private readonly purge: SignPurgeRepository,
    private readonly engine: SignPurgeService,
    private readonly envelopes: SenderEnvelopeService,
  ) {}

  @Get('retention-policy')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  async getPolicy(@AuthContext() auth: AuthContextType) {
    const p = await this.purge.getPolicy(auth.tenant_id);
    return {
      retention_days: p.retention_days,
      purge_level: p.purge_level,
      updated_at: p.updated_at !== null ? p.updated_at.toISOString() : null,
      can_edit: this.engine.enabled && auth.scopes.includes(ESIGN_SCOPE.SETTINGS_MANAGE),
    };
  }

  @Put('retention-policy')
  @EsignSenderBoundary(ESIGN_SCOPE.SETTINGS_MANAGE)
  async setPolicy(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { retention_days?: unknown; purge_level?: unknown }) {
    this.assertEnabled(requestId);
    const days = body?.retention_days;
    if (!(days === null || (typeof days === 'number' && Number.isInteger(days) && days >= RETENTION_DAYS_MIN && days <= RETENTION_DAYS_MAX))) {
      throw bad(requestId, `retention_days must be null (keep forever) or an integer ${RETENTION_DAYS_MIN}..${RETENTION_DAYS_MAX}`, 'invalid_retention_days');
    }
    const level = body?.purge_level ?? 'DOCUMENTS';
    if (!isPurgeLevel(level)) throw bad(requestId, 'purge_level is not recognised', 'invalid_purge_level');
    const p = await this.purge.setPolicy(auth.tenant_id, { retention_days: days, purge_level: level }, auth.sub);
    return { retention_days: p.retention_days, purge_level: p.purge_level, updated_at: p.updated_at !== null ? p.updated_at.toISOString() : null, can_edit: true };
  }

  @Post('envelopes/:id/delete')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  async deleteForTenant(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    this.assertEnabled(requestId);
    await this.envelopes.assertVisible(auth, id, requestId);
    const out = await this.purge.partyDelete(auth.tenant_id, id, { kind: 'SENDER', key: auth.tenant_id }, auth.sub);
    if (out === 'not_eligible') throw conflict(requestId, 'Only a completed, declined, voided or expired envelope can be deleted', 'envelope_not_terminal');
    return { deleted: true };
  }

  @Post('envelopes/:id/restore')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  async restoreForTenant(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    this.assertEnabled(requestId);
    await this.envelopes.assertVisible(auth, id, requestId);
    const out = await this.purge.partyRestore(auth.tenant_id, id, { kind: 'SENDER', key: auth.tenant_id }, auth.sub);
    if (out === 'purged') throw new AramoError('ENVELOPE_PURGED', `envelope ${id} was purged`, 410, { requestId });
    return { restored: out === 'restored' };
  }

  @Post('envelopes/:id/purge')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SCOPE.ENVELOPE_MANAGE_ALL)
  async queuePurge(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: { level?: unknown }) {
    this.assertEnabled(requestId);
    const level = body?.level ?? 'DOCUMENTS';
    if (!isPurgeLevel(level)) throw bad(requestId, 'level is not recognised', 'invalid_purge_level');
    await this.envelopes.assertVisible(auth, id, requestId);
    const out = await this.purge.queue(auth.tenant_id, id, { level: level as PurgeLevel, reason: 'manual', actor_user_id: auth.sub });
    if (out === 'not_eligible') throw conflict(requestId, 'Only a completed, declined or voided envelope can be purged', 'envelope_not_purgeable');
    if (out === 'executed') throw new AramoError('ENVELOPE_PURGED', `envelope ${id} was purged`, 410, { requestId });
    return { purge: await this.statusOf(auth.tenant_id, id) };
  }

  @Post('envelopes/:id/purge/dequeue')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SCOPE.ENVELOPE_MANAGE_ALL)
  async dequeuePurge(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    this.assertEnabled(requestId);
    await this.envelopes.assertVisible(auth, id, requestId);
    const out = await this.purge.dequeue(auth.tenant_id, id, auth.sub);
    if (out === 'not_queued') throw conflict(requestId, 'This envelope has no queued purge', 'purge_not_queued');
    return { purge: await this.statusOf(auth.tenant_id, id) };
  }

  @Post('purge/targeted')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_SCOPE.SETTINGS_MANAGE)
  async targeted(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { email?: unknown; level?: unknown }) {
    this.assertEnabled(requestId);
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    if (!EMAIL.test(email) || email.length > 320) throw bad(requestId, 'email is required', 'invalid_email');
    const level = body?.level ?? 'DOCUMENTS';
    if (!isPurgeLevel(level)) throw bad(requestId, 'level is not recognised', 'invalid_purge_level');
    return { queued: await this.engine.queueTargeted(auth.tenant_id, email, level as PurgeLevel, auth.sub) };
  }

  private assertEnabled(requestId: string): void {
    if (!this.engine.enabled) throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'Document retention and purge are not enabled', 403, { requestId, details: { reason: 'purge_not_enabled' } });
  }

  private async statusOf(tenant_id: string, envelope_id: string) {
    const s = await this.purge.status(tenant_id, envelope_id);
    return s === null ? null : purgeViewOf({ purge_state: s.state, purge_level: s.level, purge_due_at: s.due_at, purge_executed_at: s.executed_at });
  }
}


function bad(requestId: string, message: string, reason: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, details: { reason } });
}

function conflict(requestId: string, message: string, reason: string): AramoError {
  return new AramoError('ENVELOPE_ILLEGAL_TRANSITION', message, 409, { requestId, details: { reason } });
}
