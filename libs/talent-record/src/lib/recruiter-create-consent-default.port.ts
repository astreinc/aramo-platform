import { createAramoLogger, type AramoLogger } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';

// CONSENT-RECRUITER-CREATE-DEFAULT-1 (Amendment v1.0 LOCKED) — the dependency-
// inversion PORT through which the recruiter Talent-create paths record the
// at-create contact-consent default (email + phone). §6: NO new nx edge —
// libs/talent-record never imports @aramo/consent; apps/api binds this STRING
// token to an adapter over ConsentService (mirrors RESUME_ATTACHMENT_RESOLVER: a
// string token, not a bare class, avoids the non-strict app.get collision trap).
//
// Invoked AFTER the TalentRecord exists, from exactly the three recruiter paths
// (§2): manual create (POST /v1/talent-records, non-draft branch), résumé-first
// draft confirm, and intake promotion (both branches) — the last two via
// TalentCreateFromDraftService, so a draft-backed controller create is counted
// ONCE. NOT invoked by import (createForImport) or the Sourcing Promotion Gate.
export const RECRUITER_CREATE_CONSENT_DEFAULT = 'RECRUITER_CREATE_CONSENT_DEFAULT';

export interface RecruiterCreateConsentDefaultPort {
  recordDefault(input: {
    talent_record_id: string;
    authContext: AuthContextType;
    requestId: string;
  }): Promise<void>;
}

const logger: AramoLogger = createAramoLogger('RecruiterCreateConsentDefault');

/**
 * §5 fail-soft invocation: Talent creation NEVER fails because of the consent
 * write (separate stores, no shared transaction). A failure is logged as a
 * structured warning carrying ids only (no PII) and swallowed; the Talent then
 * shows "Contact restricted" until a recruiter records consent on Talent 360.
 * No-op when the port is unbound (hand-wired unit tests, non-api roots) or the
 * caller is not a recruiter consumer.
 */
export async function applyRecruiterCreateConsentDefault(
  port: RecruiterCreateConsentDefaultPort | undefined,
  input: { talent_record_id: string; authContext: AuthContextType; requestId: string },
): Promise<void> {
  if (port === undefined) return;
  if (input.authContext.consumer_type !== 'recruiter') return;
  try {
    await port.recordDefault(input);
  } catch (err) {
    logger.warn({
      event: 'recruiter_create_consent_default_failed',
      tenant_id: input.authContext.tenant_id,
      talent_record_id: input.talent_record_id,
      request_id: input.requestId,
      error_name: err instanceof Error ? err.name : 'unknown',
      error_code:
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code: unknown }).code)
          : undefined,
    });
  }
}
