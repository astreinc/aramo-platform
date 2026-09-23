// COMM-C4 (RCE-1) — authoritative recipient resolution for a requisition-contact
// email. The send contract carries NO client-supplied address: the recipient is
// ALWAYS the target Talent's authoritative primary email (email1), reloaded
// server-side from the TalentRecord. The email service depends on this port; the
// concrete adapter reads the tenant-scoped live TalentRecord. A Talent with no
// email1 — including a cross-tenant or absent Talent, which yields no row —
// fails closed (TalentEmailUnavailableError), before Graph is called and before
// any CommunicationInteraction is written.

export const EMAIL_RECIPIENT_RESOLVER = 'EMAIL_RECIPIENT_RESOLVER';

export interface ResolveRecipientRequest {
  readonly tenant_id: string;
  readonly talent_record_id: string;
}

export class TalentEmailUnavailableError extends Error {
  constructor(readonly talent_record_id: string) {
    super('the Talent has no authoritative email for requisition-contact send');
    this.name = 'TalentEmailUnavailableError';
  }
}

export interface EmailRecipientResolver {
  /**
   * Returns the Talent's authoritative primary email (email1) for the tenant.
   * Throws TalentEmailUnavailableError when the live TalentRecord has no email1
   * or does not exist within the tenant (fail-closed; no fallback address).
   */
  resolveRecipientEmail(req: ResolveRecipientRequest): Promise<string>;
}
