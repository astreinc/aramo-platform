import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  ACCOUNT_LINK_DIRECTORY,
  type AccountLinkAttachResult,
  type AccountLinkDirectory,
  type AccountLinkMethod,
  type AccountLinkProof,
  type AccountLinkRemoveResult,
  type AccountLinkVerifyResult,
} from './account-link-directory.port.js';
import { renderLinkCodeEmail, renderSignInMethodNoticeEmail } from './account-link-email.js';
import { EMAIL_SENDER, type EmailSender } from './email-sender.port.js';

// Apple Go-Live Amendment A1 (LOCKED) — the auth-side orchestration of proven
// account linking: it decides WHEN a pending link is offered (L-2), runs the three
// proofs through the AccountLinkDirectory port, and sends the emails (the code,
// L-4 b; the security notice on add and remove, L-5) through auth's existing
// EmailSender port. It never mints a session: the callers do that, and a pending
// link never leads to one.

// The two denials that offer a pending link (L-2).
export const PENDING_LINK_DENIALS: ReadonlySet<string> = new Set(['user_not_provisioned', 'idp_identity_conflict']);
// The federated providers a pending link can carry.
export const LINKABLE_IDPS: ReadonlySet<string> = new Set(['google', 'microsoft', 'apple']);
// A handle is base64url of 32 random bytes (43 characters); anything else is
// ignored before it reaches the store.
const HANDLE_RE = /^[A-Za-z0-9_-]{43}$/;

export function isLinkHandle(v: unknown): v is string {
  return typeof v === 'string' && HANDLE_RE.test(v);
}

// Per-IP fixed window for POST /auth/link/email/start — the codebase's rate-limit
// convention (PortalLoginBudget / SignupBudget: in-memory, per process, correct on
// the single box). Applied uniformly before any branch, so the limiter is not an
// oracle either.
const LINK_EMAIL_BUDGET_MAX = 10;
const LINK_EMAIL_BUDGET_WINDOW_MS = 10 * 60 * 1000;

@Injectable()
export class LinkEmailBudget {
  private readonly windows = new Map<string, { start: number; count: number }>();
  allow(key: string, now: number): boolean {
    const w = this.windows.get(key);
    if (w === undefined || now - w.start >= LINK_EMAIL_BUDGET_WINDOW_MS) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= LINK_EMAIL_BUDGET_MAX) return false;
    w.count += 1;
    return true;
  }
  reset(): void {
    this.windows.clear();
  }
}

export interface PendingLinkOffer {
  handle: string;
  idp: string;
}

export interface VerifiedIdentityForLink {
  sub: string;
  email: string;
  idp: string | null;
}

@Injectable()
export class AccountLinkService {
  private readonly logger = new Logger(AccountLinkService.name);

  constructor(
    @Inject(ACCOUNT_LINK_DIRECTORY) private readonly directory: AccountLinkDirectory,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    private readonly budget: LinkEmailBudget,
  ) {}

  /**
   * L-2 — after a denied sign-in: write a pending link when the denial is one of
   * the two linkable ones and the provider is known. Best-effort: a failure here
   * leaves the denial exactly as it was (no handle).
   */
  async offerPendingLink(reason: string, verified: VerifiedIdentityForLink): Promise<PendingLinkOffer | null> {
    if (!PENDING_LINK_DENIALS.has(reason)) return null;
    if (verified.idp === null || !LINKABLE_IDPS.has(verified.idp)) return null;
    try {
      return await this.directory.createPendingLink({
        provider: 'cognito',
        provider_subject: verified.sub,
        idp: verified.idp,
        verified_email: verified.email,
        reason,
      });
    } catch (err) {
      this.logger.warn(`pending link create failed (non-blocking): ${(err as Error).message}`);
      return null;
    }
  }

  /** Proof (a) — the sign-in resolved `principal_id` normally; attach the pending identity. */
  async attachAfterSignIn(handle: string, principal_id: string): Promise<AccountLinkAttachResult> {
    let result: AccountLinkAttachResult;
    try {
      result = await this.directory.attachPendingLink({ handle, principal_id });
    } catch (err) {
      this.logger.warn(`pending link attach failed (sign-in proceeds): ${(err as Error).message}`);
      return { ok: false, reason: 'link_expired' };
    }
    await this.noticeIfLinked(result);
    return result;
  }

  /** Proof (c) — a signed-in principal adds a provider (path 1). */
  async attachSignedIn(principal_id: string, verified: VerifiedIdentityForLink): Promise<AccountLinkAttachResult> {
    const result = await this.directory.attachIdentity({
      provider: 'cognito',
      provider_subject: verified.sub,
      idp: verified.idp,
      verified_email: verified.email,
      principal_id,
      proof: 'signed_in' satisfies AccountLinkProof,
    });
    await this.noticeIfLinked(result);
    return result;
  }

  /**
   * Proof (b) start. Always returns normally (the controller answers 202 {}); the
   * email is sent without being awaited so a known and an unknown address take
   * the same time to answer.
   */
  async startEmailProof(input: { handle: unknown; email: unknown; ip: string }): Promise<void> {
    if (!this.budget.allow(`link_email:${input.ip}`, Date.now())) return;
    if (!isLinkHandle(input.handle)) return;
    const email = typeof input.email === 'string' && input.email.length <= 320 ? input.email : null;
    let send: { to: string; code: string; idp: string } | null;
    try {
      send = await this.directory.startEmailProof({ handle: input.handle, email });
    } catch (err) {
      this.logger.warn(`link email start failed: ${(err as Error).message}`);
      return;
    }
    if (send === null) return;
    const rendered = renderLinkCodeEmail({ code: send.code, idp: send.idp });
    void this.email.send({ to: send.to, ...rendered }).catch((err: unknown) => {
      this.logger.warn(`link code email failed: ${(err as Error).message}`);
    });
  }

  async verifyEmailProof(input: { handle: unknown; code: unknown }): Promise<AccountLinkVerifyResult> {
    if (!isLinkHandle(input.handle)) return { ok: false, reason: 'link_expired' };
    const result = await this.directory.verifyEmailProof({ handle: input.handle, code: input.code });
    await this.noticeIfLinked(result);
    return result;
  }

  listSignInMethods(principal_id: string): Promise<AccountLinkMethod[]> {
    return this.directory.listSignInMethods(principal_id);
  }

  async removeSignInMethod(principal_id: string, idp: string): Promise<AccountLinkRemoveResult> {
    const result = await this.directory.removeSignInMethod({ principal_id, idp });
    if (result.ok) await this.sendNotice(result.account_email, result.idp, 'removed');
    return result;
  }

  private async noticeIfLinked(result: AccountLinkAttachResult | AccountLinkVerifyResult): Promise<void> {
    if (result.ok) await this.sendNotice(result.account_email, result.idp, 'added');
  }

  // L-5 — the security email. Best-effort: a mail failure never undoes the change.
  private async sendNotice(to: string, idp: string, change: 'added' | 'removed'): Promise<void> {
    try {
      await this.email.send({ to, ...renderSignInMethodNoticeEmail({ idp, change }) });
    } catch (err) {
      this.logger.warn(`sign-in method notice email failed: ${(err as Error).message}`);
    }
  }
}
