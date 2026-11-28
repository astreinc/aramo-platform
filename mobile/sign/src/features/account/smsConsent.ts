// SMS-CONSENT-1 §1/§2 — the signed-in person's own SMS consent (R-3) and the send flow's
// certification check (R-2). The server decides everything; `available` is false until an
// SMS provider can send and a text launch key is on (R-8), and every screen stays hidden then.
//   GET    /v1/sign/me/sms-consent         → SmsConsentStatus
//   POST   /v1/sign/me/sms-consent/phone   { phone_e164 }  → a code is texted
//   POST   /v1/sign/me/sms-consent/verify  { code }
//   PUT    /v1/sign/me/sms-consent         { consented, wording_version, channel }
//   DELETE /v1/sign/me/sms-consent         → the number and the consent are removed
// Local types (workspace.request): the generated OpenAPI types are regenerated with the server.
import type { WorkspaceClient } from '../../api/workspaceClient';

export type SmsConsentChannel = 'WEB' | 'APP' | 'SIGNUP';

export interface SmsConsentStatus {
  readonly available: boolean;
  readonly phone_masked: string | null;
  readonly phone_verified: boolean;
  readonly consented: boolean;
  readonly consented_at: string | null;
  readonly wording_version: string | null;
  readonly wording: string | null;
}

export interface SmsConsentCodeSent {
  readonly sent?: boolean;
  readonly phone_masked?: string;
  readonly expires_in_seconds?: number;
  readonly resend_after_seconds?: number;
}

const ROUTE = '/v1/sign/me/sms-consent';

export async function loadSmsConsent(workspace: WorkspaceClient): Promise<SmsConsentStatus> {
  return (await workspace.request<SmsConsentStatus>({ method: 'GET', path: ROUTE })).data;
}

export async function sendSmsConsentCode(
  workspace: WorkspaceClient,
  phone: string,
): Promise<SmsConsentCodeSent> {
  return (
    await workspace.request<SmsConsentCodeSent>({
      method: 'POST',
      path: `${ROUTE}/phone`,
      body: { phone_e164: phone.trim() },
    })
  ).data;
}

export async function verifySmsConsentCode(
  workspace: WorkspaceClient,
  code: string,
): Promise<void> {
  await workspace.request<unknown>({ method: 'POST', path: `${ROUTE}/verify`, body: { code } });
}

export async function saveSmsConsent(
  workspace: WorkspaceClient,
  body: {
    readonly consented: boolean;
    readonly wording_version: string;
    readonly channel: SmsConsentChannel;
  },
): Promise<void> {
  await workspace.request<unknown>({ method: 'PUT', path: ROUTE, body });
}

export async function removeSmsConsent(workspace: WorkspaceClient): Promise<void> {
  await workspace.request<unknown>({ method: 'DELETE', path: ROUTE });
}

/**
 * The send flow's note (§2): the sender context says text options are launched and in the
 * plan (`sms_certification.required`) but the organization has not certified. Read from an
 * untyped context so it works before the generated types carry the field.
 */
export function smsCertificationPending(context: unknown): boolean {
  if (typeof context !== 'object' || context === null) return false;
  const c = (context as { sms_certification?: unknown }).sms_certification;
  if (typeof c !== 'object' || c === null) return false;
  const { required, certified } = c as { required?: unknown; certified?: unknown };
  return required === true && certified !== true;
}

// The optional step after signup (R-3): the signup done step marks it; after the sign-in
// that follows, Home shows it once. In memory: the sign-in happens in the same app session.
let signupOffer = false;

export function markSmsSignupOffer(): void {
  signupOffer = true;
}

export function smsSignupOfferPending(): boolean {
  return signupOffer;
}

export function clearSmsSignupOffer(): void {
  signupOffer = false;
}
