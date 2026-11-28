import { Injectable, Logger, Optional } from '@nestjs/common';
import { IdentityRepository } from '@aramo/identity';
import { SignSmsConsentRepository, type SmsCertificationRow, type UserSmsConsentRow } from '@aramo/sign';
import { SMS_CERTIFICATION_WORDING_VERSION, SMS_CONSENT_WORDING_VERSION } from '@aramo/sign-client';

// SMS-CONSENT-1 (LOCKED 2026-11-28) — the consent facts every SMS path reads. Bound inside the
// E-Sign module (SignMessagingService, the signing-link and code sender, lives there) and exported.
//
//   R-2  an organization is certified while its latest certification is not withdrawn and was
//        given under the current wording version (a changed wording needs a new certification);
//   R-3  a user's consent is active while their number is verified, the consent was given under
//        the current wording version and it has not been revoked (Settings or STOP);
//   R-5  an SMS to a signer goes to the number of the Aramo user whose email is the signer's
//        email, when that user's consent is active. Nothing here is ever returned to a sender.

export function isCertificationCurrent(row: Pick<SmsCertificationRow, 'withdrawn_at' | 'wording_version'> | null | undefined): boolean {
  return row != null && row.withdrawn_at === null && row.wording_version === SMS_CERTIFICATION_WORDING_VERSION;
}

export function isConsentActive(
  row: Pick<UserSmsConsentRow, 'phone_verified_at' | 'consented_at' | 'revoked_at' | 'consent_wording_version'> | null | undefined,
): boolean {
  return row != null && row.phone_verified_at !== null && row.consented_at !== null && row.revoked_at === null && row.consent_wording_version === SMS_CONSENT_WORDING_VERSION;
}

@Injectable()
export class SmsConsentFacts {
  private readonly log = new Logger(SmsConsentFacts.name);

  constructor(
    private readonly repo: SignSmsConsentRepository,
    // Absent (a narrow test composition) ⇒ no signer resolves to a user: the sender-typed number is used.
    @Optional() private readonly identity?: IdentityRepository,
  ) {}

  async organizationCertified(tenant_id: string): Promise<boolean> {
    return isCertificationCurrent(await this.repo.currentCertification(tenant_id));
  }

  /** The verified, consented number of this user, or null. */
  async consentedNumberOfUser(user_id: string): Promise<string | null> {
    const row = await this.repo.consentOf(user_id);
    return isConsentActive(row) ? (row as UserSmsConsentRow).phone_e164 : null;
  }

  /**
   * R-5 — the consented number of the Aramo user whose email is this signer's email, or null
   * (no such user, no active consent, an in-person signer without email). Never throws: a
   * failed lookup falls back to the sender-typed number.
   */
  async consentedNumberOfSigner(tenant_id: string, signer_id: string): Promise<string | null> {
    if (this.identity === undefined) return null;
    try {
      const email = (await this.repo.signerEmail(tenant_id, signer_id))?.trim();
      if (email === undefined || email === '') return null;
      const user = (await this.identity.findUserByEmail(email.toLowerCase())) ?? (email !== email.toLowerCase() ? await this.identity.findUserByEmail(email) : null);
      if (user === null || !user.is_active) return null;
      return await this.consentedNumberOfUser(user.id);
    } catch (err) {
      this.log.warn(`consented number lookup failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** R-3 — STOP from a number (inbound keyword or the provider's opt-out list) revokes every consent on it. */
  async revokeByPhone(phone_e164: string, now: Date): Promise<void> {
    try {
      await this.repo.revokeConsentByPhone(phone_e164, now);
    } catch (err) {
      this.log.warn(`consent revocation by STOP failed: ${(err as Error).message}`);
    }
  }
}
