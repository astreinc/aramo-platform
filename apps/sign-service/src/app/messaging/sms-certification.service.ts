import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { IdentityRepository } from '@aramo/identity';
import { SignSmsConsentRepository } from '@aramo/sign';
import { SMS_CERTIFICATION_WORDING, SMS_CERTIFICATION_WORDING_VERSION, SMS_NOT_IN_PLAN_REASON, type SmsCertificationView } from '@aramo/sign-client';

import { isCertificationCurrent } from './sms-consent-rules.js';
import { SignSmsPolicy } from './sms-policy.service.js';

// SMS-CONSENT-1 R-2 (LOCKED 2026-11-28) — Settings → Text messages (SMS): the organization's
// one-time certification (v1/sign/sender/sms-certification).
//
//   GET     { available, required, certified, certified_at, certified_by_name, wording_version, wording }
//   POST    { wording_version } → certified (owner / admin: sign:settings:manage)
//   DELETE  → withdrawn (owner / admin)
//
// wording / wording_version are the CURRENT wording (@aramo/sign-client). certified is true while
// the latest certification is not withdrawn and was given under the current version; who and when
// are shown only then. Refusals (details.reason): sms_not_available (403, R-8 dark),
// sms_not_in_plan (403, R-4: not a Business plan), sms_wording_outdated (400, the client showed an
// older wording). A withdrawal is always accepted (it only turns texts off).

function notAvailable(requestId: string): AramoError {
  return new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'Text messages are not available in Aramo Sign yet', 403, { requestId, details: { reason: 'sms_not_available' } });
}

@Injectable()
export class SmsCertificationService {
  constructor(
    private readonly policy: SignSmsPolicy,
    private readonly repo: SignSmsConsentRepository,
    private readonly identity: IdentityRepository,
  ) {}

  async view(tenant_id: string): Promise<SmsCertificationView> {
    const available = this.policy.available();
    const byPlan = available ? await this.policy.offeredByPlan(tenant_id) : { sms_delivery: false, sms_otp: false };
    const row = await this.repo.currentCertification(tenant_id);
    const certified = isCertificationCurrent(row);
    const by = certified && row !== null ? await this.identity.findUserById(row.certified_by_user_id).catch(() => null) : null;
    return {
      available,
      required: available && (byPlan.sms_delivery || byPlan.sms_otp),
      certified,
      certified_at: certified && row !== null ? row.certified_at.toISOString() : null,
      certified_by_name: by?.display_name?.trim() ? by.display_name.trim() : null,
      wording_version: SMS_CERTIFICATION_WORDING_VERSION,
      wording: SMS_CERTIFICATION_WORDING,
    };
  }

  async certify(auth: Pick<AuthContextType, 'tenant_id' | 'sub'>, body: { wording_version?: unknown } | undefined, requestId: string, now: Date = new Date()): Promise<SmsCertificationView> {
    if (!this.policy.available()) throw notAvailable(requestId);
    const byPlan = await this.policy.offeredByPlan(auth.tenant_id);
    if (!byPlan.sms_delivery && !byPlan.sms_otp) {
      throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'Text messages to signers are not included in your plan', 403, { requestId, details: { reason: SMS_NOT_IN_PLAN_REASON } });
    }
    if (body?.wording_version !== SMS_CERTIFICATION_WORDING_VERSION) {
      throw new AramoError('VALIDATION_ERROR', 'The certification wording has changed; read it again', 400, {
        requestId,
        details: { reason: 'sms_wording_outdated', field: 'wording_version', wording_version: SMS_CERTIFICATION_WORDING_VERSION },
      });
    }
    await this.repo.certify({ id: randomUUID(), tenant_id: auth.tenant_id, user_id: auth.sub, wording_version: SMS_CERTIFICATION_WORDING_VERSION, now });
    return this.view(auth.tenant_id);
  }

  async withdraw(auth: Pick<AuthContextType, 'tenant_id' | 'sub'>, now: Date = new Date()): Promise<SmsCertificationView> {
    await this.repo.withdraw(auth.tenant_id, auth.sub, now);
    return this.view(auth.tenant_id);
  }
}
