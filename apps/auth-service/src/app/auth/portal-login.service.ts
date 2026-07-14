import { Inject, Injectable, Logger } from '@nestjs/common';
import { computeEmailFingerprint, normalizeEmail } from '@aramo/common';
import {
  PortalIdentityRepository,
  generatePortalLoginToken,
  hashPortalLoginToken,
  portalLoginExpiresAt,
} from '@aramo/portal-identity';
import { IdentityIndexRepository } from '@aramo/identity-index';
import { MAILER_PORT, type MailerPort } from '@aramo/mailer';

import { PortalLoginBudget } from './portal-login-budget.js';
import { buildPortalLoginUrl, renderPortalLoginEmail } from './portal-login-email.js';
import { SessionOrchestratorService } from './session-orchestrator.service.js';

// Portal P1 — passwordless portal login orchestration. The controller stays
// thin (parse + neutral response + cookies); all eligibility/token/session logic
// lives here.
//
// ORACLE-RESISTANCE (Portal rulings 1 & 2): request-link NEVER reveals whether an
// email is eligible — it returns the same neutral response and the same (possibly
// no) side effect regardless. Eligibility resolves ONLY through governed aperture
// 1 (the one-way, PII-free fingerprint → ClusterFingerprint lookup) OR an existing
// PortalUser — NEVER a cross-tenant SubjectAnchor scan.

export type PortalConsumeResult =
  | { kind: 'success'; accessJwt: string; refreshTokenPlaintext: string }
  | { kind: 'failure' };

@Injectable()
export class PortalLoginService {
  private readonly logger = new Logger(PortalLoginService.name);

  constructor(
    private readonly portals: PortalIdentityRepository,
    private readonly identityIndex: IdentityIndexRepository,
    @Inject(MAILER_PORT) private readonly mailer: MailerPort,
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

    const clusterId = await this.resolveClusterId(normalized);
    const eligible =
      clusterId !== null ||
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
    // `to` is the address as typed (the mailer never templates; origin secrecy
    // holds — the email names no tenant).
    await this.mailer.send({ to: raw, subject: rendered.subject, html: rendered.html, text: rendered.text });
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

    // Lazy mint (ruling 3): cluster_id re-derived from the eligibility lookup for
    // this email (deterministic — same fingerprint the request-link path used).
    const clusterId = await this.resolveClusterId(token.email_normalized);
    const user = await this.portals.findOrCreatePortalOnLogin({
      email_normalized: token.email_normalized,
      cluster_id: clusterId,
      now,
    });
    const sess = await this.session.establishPortalSession({ portal_user_id: user.id });
    return { kind: 'success', accessJwt: sess.accessJwt, refreshTokenPlaintext: sess.refreshTokenPlaintext };
  }

  /**
   * Ruling 1 — eligibility through the index ONLY: normalized email →
   * computeEmailFingerprint (one-way, PII-free, aperture 1) → ClusterFingerprint
   * lookup. Returns the cluster id when a fingerprint exists (under PORTABLE_ONLY,
   * that IS "a verified email admitted somewhere"), else null. NEVER scans
   * SubjectAnchor across tenants.
   */
  private async resolveClusterId(emailNormalized: string): Promise<string | null> {
    const fingerprint = computeEmailFingerprint(emailNormalized);
    const cluster = await this.identityIndex.findClusterByFingerprint(fingerprint);
    return cluster?.id ?? null;
  }
}
