import { Inject, Injectable, Logger } from '@nestjs/common';
import { normalizeEmail } from '@aramo/common';
import {
  PortalIdentityRepository,
  generatePortalLoginToken,
  hashPortalLoginToken,
  portalLoginExpiresAt,
} from '@aramo/portal-identity';

import { EMAIL_SENDER, type EmailSender } from './email-sender.port.js';
import { ELIGIBILITY_POLICY, type EligibilityPolicy } from './eligibility-policy.port.js';
import { PortalLoginBudget } from './portal-login-budget.js';
import { buildPortalLoginUrl, renderPortalLoginEmail } from './portal-login-email.js';
import { SessionOrchestratorService } from './session-orchestrator.service.js';

// Portal P1 — passwordless portal login orchestration. The controller stays
// thin (parse + neutral response + cookies); all eligibility/token/session logic
// lives here.
//
// ORACLE-RESISTANCE (Portal rulings 1 & 2): request-link NEVER reveals whether an
// email is eligible — it returns the same neutral response and the same (possibly
// no) side effect regardless. Eligibility resolves ONLY through the governed
// EligibilityPolicy port (aperture 1, opaque subject_ref) OR an existing
// PortalUser — NEVER a cross-tenant SubjectAnchor scan.
//
// Auth-Decoupling PR-2/3 (ADR-0021 §2): this service depends on the auth-owned
// EmailSender / EligibilityPolicy PORTS, not on @aramo/mailer, @aramo/identity-index,
// or computeEmailFingerprint. The fingerprint computation (and the pepper) now
// live in IdentityIndexEligibilityAdapter; the mail send in
// MailerEmailSenderAdapter. Method bodies, ordering, and control flow are
// otherwise unchanged (behaviour-preserving, R-P23-5).

export type PortalConsumeResult =
  | { kind: 'success'; accessJwt: string; refreshTokenPlaintext: string }
  | { kind: 'failure' };

@Injectable()
export class PortalLoginService {
  private readonly logger = new Logger(PortalLoginService.name);

  constructor(
    private readonly portals: PortalIdentityRepository,
    @Inject(ELIGIBILITY_POLICY) private readonly eligibility: EligibilityPolicy,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    private readonly session: SessionOrchestratorService,
    private readonly budget: PortalLoginBudget,
  ) {}

  /**
   * Request a magic link. Rulings 1 & 2: uniform limiter first (keyed on IP,
   * never on eligibility); if the address is eligible, mint-or-rotate a token and
   * send the link; regardless, the caller returns the identical neutral response.
   * Malformed-but-parseable and unknown addresses take the SAME no-mail path.
   */
  async requestLink(input: {
    email: unknown;
    ip: string;
    baseUrl: string;
  }): Promise<void> {
    // Uniform rate limit BEFORE any eligibility branch (oracle-resistance).
    if (!this.budget.allow(input.ip, Date.now())) return;

    const raw = typeof input.email === 'string' ? input.email : '';
    const normalized = normalizeEmail(raw);
    // A structurally-unusable address takes the same silent no-mail path as an
    // unknown one — no distinct error, no branch observable to the requester.
    if (normalized.length === 0 || !normalized.includes('@')) return;

    const resolved = await this.eligibility.resolve(normalized);
    const eligible =
      resolved !== null ||
      (await this.portals.findPortalByEmail(normalized)) !== null;
    if (!eligible) return; // unknown → NO mail (ruling 2)

    // Mint or rotate-in-place (TR-3 idempotency-read pattern).
    const now = new Date();
    const { raw: rawToken, hash } = generatePortalLoginToken();
    const expiresAt = portalLoginExpiresAt(now);
    const open = await this.portals.findOpenLoginToken(normalized, now);
    if (open !== null) {
      await this.portals.rotateLoginToken({ id: open.id, token_hash: hash, expires_at: expiresAt });
    } else {
      await this.portals.createLoginToken({ email_normalized: normalized, token_hash: hash, expires_at: expiresAt });
    }

    const confirmUrl = buildPortalLoginUrl(input.baseUrl, rawToken);
    const rendered = renderPortalLoginEmail({ confirmUrl });
    // `to` is the address as typed (the sender never templates; origin secrecy
    // holds — the email names no tenant).
    await this.email.send({ to: raw, subject: rendered.subject, html: rendered.html, text: rendered.text });
  }

  /**
   * Consume a presented raw token. Uniform limiter first; atomic single-use
   * consume; on success lazy-mint (or find) the PortalUser with the cluster
   * from the eligibility lookup (ruling 3), then establish a platform-style portal
   * session. Every failure mode (over-budget / missing / invalid / expired /
   * replayed) returns ONE neutral failure — no reason taxonomy on the wire.
   */
  async consume(input: { rawToken: unknown; ip: string }): Promise<PortalConsumeResult> {
    if (!this.budget.allow(input.ip, Date.now())) return { kind: 'failure' };
    const raw = typeof input.rawToken === 'string' ? input.rawToken : '';
    if (raw.length === 0) return { kind: 'failure' };

    const now = new Date();
    const token = await this.portals.consumeLoginToken(hashPortalLoginToken(raw), now);
    if (token === null) return { kind: 'failure' };

    // Lazy mint (ruling 3): the opaque subject_ref re-derived from the eligibility
    // lookup for this email (deterministic — the same resolution the request-link
    // path used). Passed through to the portal store unread as cluster_id.
    const resolved = await this.eligibility.resolve(token.email_normalized);
    const user = await this.portals.findOrCreatePortalOnLogin({
      email_normalized: token.email_normalized,
      cluster_id: resolved?.subject_ref ?? null,
      now,
    });
    const sess = await this.session.establishPortalSession({ portal_user_id: user.id });
    return { kind: 'success', accessJwt: sess.accessJwt, refreshTokenPlaintext: sess.refreshTokenPlaintext };
  }
}
