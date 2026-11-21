import { Injectable, Logger, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import {
  hashSigningToken,
  inboxHandleKey,
  InboxSigningRefusedError,
  isUuid,
  mintInboxHandle,
  openInboxHandle,
  RecipientInboxRepository,
  type RecipientInboxEntry,
  type RecipientInboxRow,
  SignPurgeRepository,
  signBaseUrl,
} from '@aramo/sign';
import { IdentityRepository } from '@aramo/identity';
import { isPartyDeletable } from '@aramo/sign-client';

import { SIGNING_LINK_VALID_DAYS, senderHttp } from '../sender/envelope-contracts.js';
import { purgeNotEnabled, refusalError } from '../sender/envelope-actions.js';
import { purgeViewOf } from '../retention/purge-view.js';
import { SignPurgeService } from '../retention/sign-purge.service.js';
import { recipientSenderLabel } from '../sender-label.js';

import { type InboxActionEntry, type InboxActionFacts, inboxActions, inboxDownloadDecision, inboxSignable } from './inbox-actions.js';

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
//
// Retention and Purge directive (ebd41d99) R-10 / LD-5 — two different actions:
//   remove   (DELETE /:id)       revokes the binding: the envelope leaves the inbox for good
//                                and this user is no longer a party for the purge rule.
//   delete   (POST /:id/delete)  the DocuSign "Deleted" folder: the binding stays, the
//                                envelope moves to ?folder=deleted and can be restored; once
//                                every party has deleted it, the envelope is queued for purge.
// delete / restore apply to terminal envelopes only and are refused (403
// ESIGN_FEATURE_NOT_AVAILABLE) while purge is disabled (SIGN_PURGE_ENABLED unset).
//
// Aramo Sign W2 (Aramo-Sign-W2-Inbox-Discovery-Gate5-Plan-and-Amendment-v1_0-LOCKED) — the
// list also carries DISCOVERED items: recipient rows addressed to the user's current
// account email, listed without any binding when the user holds a qualifying federated
// link for that email recorded no later than the envelope was sent (W-1, W-2). Discovery
// grants listing and session eligibility only. A discovered item's id is an opaque,
// user-bound, 30-minute handle (C3); POST /:handle/sign re-runs the whole rule before it
// mints. Without SIGN_INBOX_HANDLE_KEY there is no discovery (fail closed).
//
// can_sign (bound and discovered alike) = the shared turn rule (sequential turn + witness
// readiness) + envelope signable + not expired + a live emailed link (W-3). A signable row
// whose turn is later is `upcoming` (listed in `waiting`, can_sign false).

// Client Rule Consolidation C1 — the facts the inbox action rules read (inbox-actions.ts).
function actionEntryOf(r: RecipientInboxEntry): InboxActionEntry {
  return {
    source: r.source,
    envelope_status: r.envelope.status,
    signer_status: r.signer.status,
    envelope_expires_at: r.envelope.expires_at ?? null,
    purge_state: r.envelope.purge_state ?? null,
    turn: r.turn,
    link_live: r.link_live,
  };
}

function notFound(requestId: string): AramoError {
  return new AramoError('NOT_FOUND', 'Not in your inbox', 404, { requestId, details: { reason: 'inbox_item_not_found' } });
}

@Injectable()
export class RecipientInboxService {
  private readonly log = new Logger(RecipientInboxService.name);

  constructor(
    private readonly repo: RecipientInboxRepository,
    private readonly identity: IdentityRepository,
    @Optional() private readonly purges?: SignPurgeRepository,
    @Optional() private readonly purgeEngine?: SignPurgeService,
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
    // W2 W-5 — an inactive or deactivated account has no verified email to claim with (the
    // same check as assign / self-sign).
    const active = user !== null && user.is_active && user.deactivated_at === null;
    const mine = active ? user.email?.trim().toLowerCase() : undefined;
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

  private async view(r: RecipientInboxEntry, user_id: string, id: string = r.id, folder: InboxActionFacts = { in_deleted_folder: false, removed: false }) {
    // M-A13 R-3 — a PERSONAL sender is shown by their own name, never the stored tenant handle.
    const from = await recipientSenderLabel(this.identity, r.envelope_tenant_id, r.envelope.created_by ?? null);
    const now = new Date();
    const entry = actionEntryOf(r);
    // C1 — can_sign, can_download and actions come from the same rules (inbox-actions.ts).
    const actions = inboxActions(entry, folder, now);
    const purge = purgeViewOf(r.envelope);
    const upcoming = inboxSignable(entry, now) && r.turn === 'later';
    // Discovered items list the signed copy through the emailed link only (no handle route
    // for it): can_download stays false for them.
    const can_download = actions.download;
    return {
      id,
      source: r.source,
      // W2 (orchestrator addition) — the signed-in user sent this envelope (a boolean only).
      i_am_sender: r.envelope.created_by === user_id,
      subject: r.envelope.subject,
      from,
      envelope_status: r.envelope.status,
      my_status: upcoming ? 'upcoming' : r.signer.status,
      sent_at: r.envelope.sent_at?.toISOString() ?? null,
      // The envelope's own expiry (Sign Mobile C-14: the same value the sender
      // detail reports as envelope_expires_at; the link window is separate).
      expires_at: r.envelope.expires_at?.toISOString() ?? null,
      envelope_expires_at: r.envelope.expires_at?.toISOString() ?? null,
      signing_link_valid_days: SIGNING_LINK_VALID_DAYS,
      completed_at: r.envelope.completed_at?.toISOString() ?? null,
      signed_at: r.signer.signed_at?.toISOString() ?? null,
      can_sign: actions.sign,
      can_download,
      // Present only once the envelope was queued for purge (the item shape is unchanged otherwise).
      ...(purge !== null ? { purge } : {}),
      // Client Rule Consolidation C1 — what the user may do with this item.
      actions,
    };
  }

  // W2 §A3.1 — the discovered rows (none without the handle key, or without a proof of the
  // current email), each with a fresh handle bound to this user.
  private async discovered(auth: AuthContextType, key: Buffer | null): Promise<Array<{ row: RecipientInboxEntry; id: string }>> {
    if (key === null) return [];
    const proof = await this.repo.verifiedEmailProof(auth.sub);
    if (proof === null) return [];
    const now = new Date();
    const rows = await this.repo.listDiscoveredForUser(auth.sub, proof, now);
    return rows.map((row) => ({ row, id: mintInboxHandle(key, { signer_id: row.signer_id, user_id: auth.sub }, now) }));
  }

  async list(auth: AuthContextType, folder?: string, requestId = '') {
    if (folder !== undefined && folder !== 'deleted') throw new AramoError('VALIDATION_ERROR', 'unknown folder', 400, { requestId, details: { folder } });
    const deleted = new Set(this.purges !== undefined ? await this.purges.deletedEnvelopeIds({ kind: 'RECIPIENT', key: auth.sub }) : []);
    // M-A17 §3 — entries this user deleted from their inbox are listed in the Deleted folder.
    const removed = await this.repo.removedSignerIds(auth.sub);
    const inFolder = (r: RecipientInboxRow): boolean => (folder === 'deleted') === (deleted.has(r.envelope_id) || removed.has(r.signer_id));
    const bound = (await this.repo.listForUser(auth.sub)).filter(inFolder).map((row) => ({ row, id: row.id }));
    // Dedupe (rule 5): a recipient reachable through a binding is listed once, as bound.
    const boundSigners = new Set(bound.map((b) => b.row.signer_id));
    const found = (await this.discovered(auth, inboxHandleKey())).filter((d) => inFolder(d.row) && !boundSigners.has(d.row.signer_id));
    const items = await Promise.all(
      [...bound, ...found].map((i) => this.view(i.row, auth.sub, i.id, { in_deleted_folder: deleted.has(i.row.envelope_id) || removed.has(i.row.signer_id), removed: removed.has(i.row.signer_id) })),
    );
    return {
      waiting: items.filter((i) => i.can_sign || i.my_status === 'upcoming'),
      completed: items.filter((i) => i.can_download),
      other: items.filter((i) => !i.can_sign && i.my_status !== 'upcoming' && !i.can_download),
    };
  }

  // Sign Mobile M-A2 §2.2 — continuing authority: the repository revalidates the
  // association, the envelope, the signer, the sequential turn and the claimed
  // link in ONE transaction, then mints a session of at most 30 minutes and audits
  // it on the ledger (RECIPIENT_INBOX_SESSION_ISSUED). Refusals carry a stable
  // details.reason (see envelope-contracts.ts). A foreign binding is not found.
  async sign(auth: AuthContextType, id: string, requestId: string) {
    const base = this.base(requestId);
    // W2 §A3.4 — a uuid is a binding id; anything else can only be a discovered-item handle.
    if (!isUuid(id)) return this.signDiscovered(auth, id, base, requestId);
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

  // W2 §A3.3 / §A3.4 (Lead C3) — a tampered, expired or other user's handle, or no key, is
  // one answer: 404 inbox_item_not_found. A valid handle only names the recipient row; the
  // repository re-runs the discovery rule and today's revalidation before minting. Only
  // reason codes are logged (never the handle).
  private async signDiscovered(auth: AuthContextType, handle: string, base: string, requestId: string) {
    const key = inboxHandleKey();
    const claims = key === null ? null : openInboxHandle(key, handle, auth.sub);
    if (claims === null) {
      this.log.log(`recipient session refused origin=inbox user=${auth.sub} reason=inbox_item_not_found request=${requestId}`);
      throw notFound(requestId);
    }
    let issued: Awaited<ReturnType<RecipientInboxRepository['issueDiscoveredRecipientSession']>>;
    try {
      issued = await this.repo.issueDiscoveredRecipientSession(auth.sub, claims.signer_id);
    } catch (e) {
      if (e instanceof InboxSigningRefusedError) {
        this.log.log(`recipient session refused origin=inbox discovery=verified_account_email user=${auth.sub} reason=${e.reason} request=${requestId}`);
        throw senderHttp(e, requestId);
      }
      throw e;
    }
    this.log.log(`recipient session issued origin=inbox discovery=verified_account_email user=${auth.sub} session=${issued.session_id} client=${auth.client ?? 'browser'} request=${requestId}`);
    return { signing_url: `${base}/s/${issued.raw_token}`, expires_at: issued.expires_at.toISOString() };
  }

  async signedCopy(auth: AuthContextType, id: string, requestId: string) {
    const r = isUuid(id) ? await this.repo.getForUser(auth.sub, id) : null;
    if (r === null) throw notFound(requestId);
    // C1 — the download rule (inbox-actions.ts); a uuid id is a bound item.
    const refused = inboxDownloadDecision({ source: 'bound', envelope_status: r.envelope.status, signer_status: r.signer.status, purge_state: r.envelope.purge_state ?? null });
    if (refused !== null && refused !== 'noop') throw refusalError(refused, requestId);
    const raw = await this.repo.issueRecipientCopyAccess(r.envelope_tenant_id, r.envelope_id, r.signer_id);
    return { download_url: `${this.base(requestId)}/d/${raw}` };
  }

  async remove(auth: AuthContextType, id: string, requestId: string) {
    if (!isUuid(id) || !(await this.repo.revoke(auth.sub, id))) throw notFound(requestId);
    return { removed: true };
  }

  // R-10 — move a terminal envelope to this recipient's Deleted folder (binding kept).
  async deleteForMe(auth: AuthContextType, id: string, requestId: string) {
    const { purges, r } = await this.partyTarget(auth, id, requestId);
    const out = await purges.partyDelete(r.envelope_tenant_id, r.envelope_id, { kind: 'RECIPIENT', key: auth.sub }, auth.sub);
    if (out === 'not_eligible') {
      throw new AramoError('ENVELOPE_ILLEGAL_TRANSITION', 'Only a completed, declined, voided or expired envelope can be deleted', 409, { requestId, details: { reason: 'envelope_not_terminal' } });
    }
    return { deleted: true };
  }

  // M-A17 §4 — a claimed item's id or a discovered item's handle, resolved as :id/sign
  // resolves them, to this user's own entry. Anything the user cannot see is 404.
  private async ownEntry(auth: AuthContextType, id: string, requestId: string): Promise<{ signer_id: string; envelope_id: string; envelope_tenant_id: string }> {
    if (isUuid(id)) {
      const r = await this.repo.getForUser(auth.sub, id);
      if (r === null) throw notFound(requestId);
      return r;
    }
    const key = inboxHandleKey();
    const claims = key === null ? null : openInboxHandle(key, id, auth.sub);
    if (claims === null) throw notFound(requestId);
    const proof = await this.repo.verifiedEmailProof(auth.sub);
    if (proof === null) throw notFound(requestId);
    const row = (await this.repo.listDiscoveredForUser(auth.sub, proof)).find((d) => d.signer_id === claims.signer_id);
    if (row === undefined) throw notFound(requestId);
    return row;
  }

  // M-A17 §2 — "Delete from my inbox": any received item, any state, to this user's Deleted
  // folder. Nothing else changes (envelope, sender, other recipients, the emailed link).
  async removeFromInbox(auth: AuthContextType, id: string, requestId: string) {
    const entry = await this.ownEntry(auth, id, requestId);
    await this.repo.removeFromInbox(auth.sub, entry);
    return { removed: true };
  }

  // M-A17 §2 — Restore: back to the inbox.
  async returnToInbox(auth: AuthContextType, id: string, requestId: string) {
    const entry = await this.ownEntry(auth, id, requestId);
    return { restored: await this.repo.returnToInbox(auth.sub, entry.signer_id) };
  }

  async restoreForMe(auth: AuthContextType, id: string, requestId: string) {
    const { purges, r } = await this.partyTarget(auth, id, requestId);
    const out = await purges.partyRestore(r.envelope_tenant_id, r.envelope_id, { kind: 'RECIPIENT', key: auth.sub }, auth.sub);
    if (out === 'purged') throw new AramoError('ENVELOPE_PURGED', 'This envelope was purged', 410, { requestId });
    return { restored: out === 'restored' };
  }

  private async partyTarget(auth: AuthContextType, id: string, requestId: string): Promise<{ purges: SignPurgeRepository; r: RecipientInboxRow }> {
    if (this.purges === undefined || this.purgeEngine?.enabled !== true) {
      throw refusalError(purgeNotEnabled(), requestId);
    }
    const r = isUuid(id) ? await this.repo.getForUser(auth.sub, id) : null;
    if (r === null) throw notFound(requestId);
    // C3 (D-1) — the Deleted-folder rule SignPurgeRepository.partyDelete runs under the lock.
    if (!isPartyDeletable(r.envelope.status)) {
      throw new AramoError('ENVELOPE_ILLEGAL_TRANSITION', 'Only a completed, declined, voided or expired envelope can be deleted', 409, { requestId, details: { reason: 'envelope_not_terminal' } });
    }
    return { purges: this.purges, r };
  }
}
