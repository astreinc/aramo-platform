import { Injectable } from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import { inboxHandleKey, RecipientInboxRepository } from '@aramo/sign';

// Aramo Sign Mobile M-A14 R-4 — "You're helping save paper": THIS account's own counts.
//
// Population (the envelopes this user signed), deduplicated by envelope:
//   a  self-signed: a recipient bound to the caller (Signer.bound_user_id = caller) in the
//      caller's own tenant, with that recipient SIGNED (self-sign and "Assign to me");
//   b  received: exactly the recipient inbox's matching — the caller's live bindings
//      (listForUser) and, when inbox discovery is on (SIGN_INBOX_HANDLE_KEY set) and the
//      caller holds a verified-email proof, the discovered rows (listDiscoveredForUser,
//      which lists at most its newest 200) — where the caller's recipient row is SIGNED.
// Every read is keyed by the token's subject (and, for a, its tenant): another account's
// envelopes never enter the counts.
//
// "Signed" — two choices were possible: (1) the envelope is COMPLETED, or (2) the caller's own
// recipient row is SIGNED. This uses (2): the caller has signed even while another party has
// not yet (and the card is about the caller's own signing, not the envelope's outcome).
//
// documents_signed = the number of such envelopes (an envelope is one "document" to the user,
// as in the prototype); pages_signed = the pages of all their documents, from the stored page
// sizes (a document whose pages were never measured counts as 1, as in the prototype).
// Counts only: no titles, parties, ids or company-wide figures are returned.

export interface SigningStats {
  documents_signed: number;
  pages_signed: number;
}

@Injectable()
export class SignMeSigningStatsService {
  constructor(private readonly repo: RecipientInboxRepository) {}

  async stats(auth: Pick<AuthContextType, 'sub' | 'tenant_id'>): Promise<SigningStats> {
    const envelopes = new Set<string>(await this.repo.selfSignedEnvelopeIds(auth.tenant_id, auth.sub));
    for (const r of await this.repo.listForUser(auth.sub)) if (r.signer.status === 'SIGNED') envelopes.add(r.envelope_id);
    if (inboxHandleKey() !== null) {
      const proof = await this.repo.verifiedEmailProof(auth.sub);
      if (proof !== null) {
        for (const r of await this.repo.listDiscoveredForUser(auth.sub, proof)) if (r.signer.status === 'SIGNED') envelopes.add(r.envelope_id);
      }
    }
    if (envelopes.size === 0) return { documents_signed: 0, pages_signed: 0 };
    const docs = await this.repo.documentPageCounts([...envelopes]);
    const pages = docs.filter((d) => envelopes.has(d.envelope_id)).reduce((n, d) => n + (d.pages ?? 1), 0);
    return { documents_signed: envelopes.size, pages_signed: pages };
  }
}
