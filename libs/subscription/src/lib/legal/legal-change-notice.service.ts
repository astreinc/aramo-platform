import {
  LEGAL_CHANGE_NOTICE_TEMPLATE,
  LegalChangeNoticeRefusedError,
  assertTemplateSendable,
  legalChangeAudience,
  renderLegalChangeNotice,
  resolveLegalChangeNotice,
  templateSha256,
  type LegalChangeNoticeTemplate,
} from './legal-change-notice.template.js';
import type { LegalChangeNoticeRepository, LegalNoticeRunCounts } from './legal-change-notice.repository.js';
import { LEGAL_DOCUMENTS, type LegalDocumentVersion } from './legal-documents.js';

// Privacy Notice 1.1 remediation E-6 — the operator-triggered account-holder notice run.
// Nothing calls this on a schedule or at boot: only the operator command
// (apps/platform-admin legal-change-notice.main.ts) does, in one of two modes:
//
//   DRY_RUN  enumerates the active account holders and returns COUNTS only. No email is sent and
//            no delivery row is written (the run row with its counts is the audit record).
//   SEND     refused while the template is DRAFT unless the operator names it exactly
//            (--approved-template) and gives an authorization reference. For each recipient:
//            claim (idempotent per document, version and user) → send ONE email to that one
//            address → record SENT with the provider message id, or FAILED with an error code.
//            Rate-limited. A later run skips SENT and SUPPRESSED, retries FAILED (resume), and
//            leaves PENDING rows from an interrupted run "in doubt" unless resend_in_doubt.
//
// Each email goes to a single recipient; no recipient ever sees another.

/** An active account holder: an active user with an active membership in an open tenant. */
export interface AccountHolder {
  user_id: string;
  tenant_id: string;
  email: string;
  tenant_kind: string;
}

/** The recipient enumeration port (keyset-paged by user_id ascending). */
export interface AccountHolderSource {
  activeAccountHolders(args: { after_user_id: string | null; limit: number; audience: 'ALL' | 'PERSONAL' }): Promise<AccountHolder[]>;
}

/** Structurally the @aramo/mailer MailerPort (this lib does not depend on the mailer lib). */
export interface LegalNoticeMailer {
  send(args: { to: string; subject: string; html: string; text?: string }): Promise<{ message_id: string }>;
}

export interface LegalChangeNoticeRunOptions {
  mode: 'DRY_RUN' | 'SEND';
  document_key: string;
  version: string;
  // YYYY-MM-DD
  effective_date: string;
  // SEND only: the operator's confirmation, "<template id>@<template version>".
  approved_template: string | null;
  // SEND only: the authorization reference (for example the PO authorization record).
  authorization_ref: string | null;
  // Maximum emails per second (SEND).
  rate_per_second: number;
  resend_in_doubt: boolean;
  page_size?: number;
}

export interface LegalChangeNoticeRunResult extends LegalNoticeRunCounts {
  run_id: string;
  mode: 'DRY_RUN' | 'SEND';
  document_key: string;
  version: string;
  effective_date: string;
  template: string;
  template_sha256: string;
  // DRY_RUN: how many would be sent now (eligible minus already done).
  would_send_count: number;
}

export interface LegalChangeNoticeDeps {
  repository: LegalChangeNoticeRepository;
  holders: AccountHolderSource;
  mailer: LegalNoticeMailer;
  // ses | stub | outbox — recorded with each delivery.
  provider: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  registry?: readonly LegalDocumentVersion[];
  template?: LegalChangeNoticeTemplate;
  summaries?: Readonly<Record<string, readonly string[]>>;
}

const EMAIL_PATTERN = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const MAX_RATE = 14;

/** A short, non-personal error code from a send failure (never the message text). */
export function sendErrorCode(err: unknown): string {
  const e = err as { name?: unknown; Code?: unknown; code?: unknown } | null;
  const raw = typeof e?.name === 'string' && e.name !== 'Error' ? e.name : typeof e?.Code === 'string' ? e.Code : typeof e?.code === 'string' ? e.code : 'send_failed';
  return raw.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'send_failed';
}

export class LegalChangeNoticeService {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly template: LegalChangeNoticeTemplate;

  constructor(private readonly deps: LegalChangeNoticeDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.template = deps.template ?? LEGAL_CHANGE_NOTICE_TEMPLATE;
  }

  async run(o: LegalChangeNoticeRunOptions): Promise<LegalChangeNoticeRunResult> {
    const subject = resolveLegalChangeNotice(
      { document_key: o.document_key, version: o.version, effective_date: o.effective_date, now: this.now() },
      this.deps.registry ?? LEGAL_DOCUMENTS,
      this.deps.summaries,
    );
    if (o.mode === 'SEND') {
      assertTemplateSendable(o.approved_template, this.template);
      if (o.authorization_ref === null || o.authorization_ref.trim().length === 0) {
        throw new LegalChangeNoticeRefusedError('authorization_ref_required', 'Send mode needs --authorization-ref naming the authorization to send');
      }
      if (!Number.isFinite(o.rate_per_second) || o.rate_per_second <= 0 || o.rate_per_second > MAX_RATE) {
        throw new LegalChangeNoticeRefusedError('invalid_rate', `--rate must be between 0 and ${MAX_RATE} emails per second`);
      }
    }
    const sha = templateSha256(subject.key, subject.version, this.template, this.deps.summaries);
    const rendered = renderLegalChangeNotice(subject);
    const audience = legalChangeAudience(subject.key);
    const ref = { document_key: subject.key, version: subject.version, effective_date: o.effective_date };
    const tpl = { template_id: this.template.id, template_version: this.template.version, template_sha256: sha };
    const repo = this.deps.repository;

    const run_id = await repo.createRun({
      ...ref,
      ...tpl,
      mode: o.mode,
      template_status: this.template.status,
      authorization_ref: o.mode === 'SEND' ? o.authorization_ref!.trim().slice(0, 200) : null,
    });
    const counts: LegalNoticeRunCounts = { eligible_count: 0, sent_count: 0, failed_count: 0, suppressed_count: 0, already_done_count: 0, in_doubt_count: 0 };
    const gap = o.mode === 'SEND' ? Math.ceil(1000 / o.rate_per_second) : 0;
    const limit = Math.min(Math.max(o.page_size ?? 200, 1), 1000);
    let sentSinceStart = 0;

    try {
      let after: string | null = null;
      for (;;) {
        const page = await this.deps.holders.activeAccountHolders({ after_user_id: after, limit, audience });
        for (const h of page) {
          counts.eligible_count++;
          if (o.mode === 'DRY_RUN') {
            const st = await repo.deliveryStatus({ document_key: subject.key, version: subject.version, channel: 'EMAIL', user_id: h.user_id });
            if (st === 'SENT' || st === 'SUPPRESSED') counts.already_done_count++;
            else if (st === 'PENDING') counts.in_doubt_count++;
            continue;
          }
          const claim = await repo.claimEmail({ ...ref, ...tpl, user_id: h.user_id, tenant_id: h.tenant_id, run_id, resend_in_doubt: o.resend_in_doubt }, this.now());
          if (claim.kind === 'ALREADY_DONE') {
            counts.already_done_count++;
            continue;
          }
          if (claim.kind === 'IN_DOUBT') {
            counts.in_doubt_count++;
            continue;
          }
          if (!EMAIL_PATTERN.test(h.email)) {
            await repo.markSuppressed(claim.delivery_id, 'invalid_address', this.now());
            counts.suppressed_count++;
            continue;
          }
          if (sentSinceStart > 0 && gap > 0) await this.sleep(gap);
          sentSinceStart++;
          let message_id: unknown;
          try {
            message_id = (await this.deps.mailer.send({ to: h.email, subject: rendered.subject, html: rendered.html, text: rendered.text }))?.message_id;
          } catch (err) {
            // The provider refused it: nothing was sent, so a later run may retry it.
            await repo.markFailed(claim.delivery_id, this.deps.provider, sendErrorCode(err), this.now());
            counts.failed_count++;
            continue;
          }
          if (typeof message_id !== 'string' || message_id.length === 0) {
            // Accepted without an id: it may have gone. Left PENDING (in doubt), never retried
            // automatically.
            counts.in_doubt_count++;
            continue;
          }
          // Accepted. A failure to record it propagates (the run is ABORTED) and leaves the row
          // PENDING — in doubt — so a resumed run never sends it again by default.
          await repo.markSent(claim.delivery_id, this.deps.provider, message_id, this.now());
          counts.sent_count++;
        }
        if (page.length < limit) break;
        after = page[page.length - 1]!.user_id;
      }
    } catch (err) {
      await repo.finishRun(run_id, 'ABORTED', counts, this.now()).catch(() => undefined);
      throw err;
    }
    await repo.finishRun(run_id, 'COMPLETED', counts, this.now());
    return {
      run_id,
      mode: o.mode,
      document_key: subject.key,
      version: subject.version,
      effective_date: o.effective_date,
      template: `${this.template.id}@${this.template.version}`,
      template_sha256: sha,
      would_send_count: o.mode === 'DRY_RUN' ? counts.eligible_count - counts.already_done_count - counts.in_doubt_count : 0,
      ...counts,
    };
  }
}
