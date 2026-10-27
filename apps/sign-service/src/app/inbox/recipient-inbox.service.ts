import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { hashSigningToken, InboxSigningRefusedError, RecipientInboxRepository, type RecipientInboxRow, signBaseUrl } from '@aramo/sign';
import { IdentityRepository } from '@aramo/identity';

import { SIGNING_LINK_VALID_DAYS, senderHttp } from '../sender/envelope-contracts.js';

// Sign Unified Product S-7 (Aramo-Sign-Unified-Product-Permission-Contract-
// Platform-API-Directive-v1_0-LOCKED §4.6, mandatory refinement B) — "Waiting for
// me" and completed-recipient views.
//
// Binding (recipient-specific, never an email match alone): the signed-in user
// presents a LIVE signing link of that recipient AND their verified Aramo email
// equals the recipient's email. Then, across tenants, the user gets ONLY:
//   - a list of their bound envelopes: subject, the sender organization's
//     display name, their own status and dates — never the sender tenant's
//     envelope list, participants, documents, subscription or internal ids;
//   - a fresh short-lived signing link for that recipient while it is signable;
//   - a short-lived signed-copy link once the envelope is complete and they signed.
// The binding grants NO membership in the sender's tenant; the emailed link stays
// independently valid; the user can remove a binding at any time.

const SIGNABLE = new Set(['SENT', 'IN_PROGRESS']);
const PENDING_SIGNER = new Set(['PENDING', 'VIEWED']);

function notFound(requestId: string): AramoError {
  return new AramoError('NOT_FOUND', 'Not in your inbox', 404, { requestId });
}

@Injectable()
export class RecipientInboxService {
  private readonly log = new Logger(RecipientInboxService.name);

  constructor(
    private readonly repo: RecipientInboxRepository,
    private readonly identity: IdentityRepository,
  ) {}

  private base(requestId: string): string {
    const b = signBaseUrl();
    if (b === null) throw new AramoError('ESIGN_SEND_UNAVAILABLE', 'Signing links are not configured', 503, { requestId });
    return b;
  }

  async claim(auth: AuthContextType, body: { token?: unknown }, requestId: string) {
    if (typeof body?.token !== 'string' || body.token.length < 20 || body.token.length > 200) {
      throw new AramoError('VALIDATION_ERROR', 'A signing link is required', 400, { requestId });
    }
    const session = await this.repo.sessionForToken(hashSigningToken(body.token));
    // One answer for unknown / spent / expired links (no oracle).
    if (session === null || session.status === 'REVOKED' || session.status === 'EXPIRED' || session.expires_at.getTime() < Date.now()) {
      throw new AramoError('SIGNING_SESSION_INVALID', 'This signing link is not valid any more', 401, { requestId });
    }
    // M-A5 §5 — only an emailed link (origin LINK, or a legacy NULL session) can be
    // claimed. A hosted, self-sign or inbox session is refused.
    const origin = session.origin ?? null;
    if (origin !== null && origin !== 'LINK') {
      throw new AramoError('SIGNING_SESSION_INVALID', 'This signing link cannot be added to an inbox', 401, {
        requestId,
        details: { reason: 'session_origin_not_claimable' },
      });
    }
    const user = await this.identity.findUserById(auth.sub);
    const mine = user?.email?.trim().toLowerCase();
    if (mine === undefined || mine === '' || session.signer_email === null || mine !== session.signer_email.trim().toLowerCase()) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'This document was sent to a different email address', 403, {
        requestId,
        details: { reason: 'recipient_mismatch' },
      });
    }
    const b = await this.repo.bind({
      envelope_tenant_id: session.tenant_id,
      envelope_id: session.envelope_id,
      signer_id: session.signer_id,
      user_id: auth.sub,
      user_tenant_id: auth.tenant_id,
      email: mine,
      // Sign Mobile M-A2 §2.2 — inbox signing never outlives the link claimed with.
      claim_session_id: session.id,
    });
    this.log.log(`recipient binding user=${auth.sub} signer=${session.signer_id} envelope=${session.envelope_id} binding=${b.id} request=${requestId}`);
    return { id: b.id };
  }

  private async view(r: RecipientInboxRow) {
    const org = await this.identity.findTenantNameById(r.envelope_tenant_id).catch(() => null);
    const signable = SIGNABLE.has(r.envelope.status) && PENDING_SIGNER.has(r.signer.status) && (r.envelope.expires_at === null || r.envelope.expires_at.getTime() > Date.now());
    return {
      id: r.id,
      subject: r.envelope.subject,
      from: org?.display_name ?? org?.name ?? null,
      envelope_status: r.envelope.status,
      my_status: r.signer.status,
      sent_at: r.envelope.sent_at?.toISOString() ?? null,
      // The envelope's own expiry (Sign Mobile C-14: the same value the sender
      // detail reports as envelope_expires_at; the link window is separate).
      expires_at: r.envelope.expires_at?.toISOString() ?? null,
      envelope_expires_at: r.envelope.expires_at?.toISOString() ?? null,
      signing_link_valid_days: SIGNING_LINK_VALID_DAYS,
      completed_at: r.envelope.completed_at?.toISOString() ?? null,
      signed_at: r.signer.signed_at?.toISOString() ?? null,
      can_sign: signable,
      can_download: r.envelope.status === 'COMPLETED' && r.signer.status === 'SIGNED',
    };
  }

  async list(auth: AuthContextType) {
    const rows = await this.repo.listForUser(auth.sub);
    const items = await Promise.all(rows.map((r) => this.view(r)));
    return {
      waiting: items.filter((i) => i.can_sign),
      completed: items.filter((i) => i.can_download),
      other: items.filter((i) => !i.can_sign && !i.can_download),
    };
  }

  // Sign Mobile M-A2 §2.2 — continuing authority: the repository revalidates the
  // association, the envelope, the signer, the sequential turn and the claimed
  // link in ONE transaction, then mints a session of at most 30 minutes and audits
  // it on the ledger (RECIPIENT_INBOX_SESSION_ISSUED). Refusals carry a stable
  // details.reason (see envelope-contracts.ts). A foreign binding is not found.
  async sign(auth: AuthContextType, id: string, requestId: string) {
    const base = this.base(requestId);
    let issued: Awaited<ReturnType<RecipientInboxRepository['issueRevalidatedRecipientSession']>>;
    try {
      issued = await this.repo.issueRevalidatedRecipientSession(auth.sub, id);
    } catch (e) {
      if (e instanceof InboxSigningRefusedError) {
        this.log.log(`recipient session refused user=${auth.sub} binding=${id} reason=${e.reason} request=${requestId}`);
        throw senderHttp(e, requestId);
      }
      throw e;
    }
    if (issued === null) throw notFound(requestId);
    this.log.log(`recipient session issued origin=inbox user=${auth.sub} binding=${id} session=${issued.session_id} client=${auth.client ?? 'browser'} request=${requestId}`);
    return { signing_url: `${base}/s/${issued.raw_token}`, expires_at: issued.expires_at.toISOString() };
  }

  async signedCopy(auth: AuthContextType, id: string, requestId: string) {
    const r = await this.repo.getForUser(auth.sub, id);
    if (r === null) throw notFound(requestId);
    if (!(await this.view(r)).can_download) {
      throw new AramoError('ENVELOPE_ILLEGAL_TRANSITION', 'A signed copy is available once everyone has signed', 409, { requestId });
    }
    const raw = await this.repo.issueRecipientCopyAccess(r.envelope_tenant_id, r.envelope_id, r.signer_id);
    return { download_url: `${this.base(requestId)}/d/${raw}` };
  }

  async remove(auth: AuthContextType, id: string, requestId: string) {
    if (!(await this.repo.revoke(auth.sub, id))) throw notFound(requestId);
    return { removed: true };
  }
}
