import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { EntitlementRepository } from '@aramo/entitlement';
import {
  IdentityProviderPolicyService,
  IdentityRepository,
  IdentityService,
  OrganizationRegionService,
  SignupRequestRepository,
  TenantRepository,
  TenantService,
  extractEmailDomain,
  isPersonalOrDisposableDomain,
  normalizeEmail,
  validateUsOrganizationDetails,
  type UsOrganizationDetails,
} from '@aramo/identity';
import { MAILER_PORT, type MailerPort } from '@aramo/mailer';
import {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_REGISTRY,
  LegalAcceptanceService,
  approvedLegalDocument,
  legalRef,
  type LegalDocumentVersion,
} from '@aramo/subscription';


// Aramo Sign launch — self-service BUSINESS signup (Journey B; Final
// Implementation Authorization: provisioning integrity). Dark unless
// SIGN_PUBLIC_SIGNUP_ENABLED=1 (public signup activation is separately authorized).
//
//   start    → validate + rate-limit, store sha256(token) only, email the link.
//              Always the same 202 (never reveals whether an address is known).
//              Nothing else is created: no tenant, user or Cognito account
//              exists for an unverified address (no squatting).
//   complete → the link proves the address. CAS-claim the request, then create
//              the BUSINESS tenant ([core, sign]), enroll it in the enforced
//              provider-pin cohort, and create the owner (tenant_owner +
//              tenant_admin — ROLES-1 PR-2 §6) WITHOUT a
//              Cognito user or ExternalIdentity (membership ACTIVE). No temporary
//              password: the owner continues with Google or Microsoft; the first
//              federation pins the tenant's provider and links the owner
//              (AUTH-SIGNIN-1 R1/R2, Aramo-Sign-Signup-Federated-Owner). The
//              owner has NO send authority until a paid subscription opens.
//   recover  → a retry with the same link resumes: done ⇒ the same answer; a
//              crash after the saga ⇒ the owner's own new tenant is adopted.
// PERSONAL commercial sending stays deferred: personal / disposable addresses
// are refused here (BUSINESS only).

export const SIGN_SIGNUP_SYSTEM_ACTOR_ID = '01900000-0000-7000-8000-00000000519e';
export const SIGN_SIGNUP_AUDIT_SOURCE = 'sign.self_service_signup';
// ROLES-1 PR-2 (§6) — the organization roles the signup owner receives.
export const SIGN_SIGNUP_OWNER_ROLE_KEYS = ['tenant_owner', 'tenant_admin'] as const;
const SIGN_CAPABILITIES = ['core', 'sign'] as const;

const LINK_TTL_MS = 24 * 60 * 60 * 1000;
const RESEND_GAP_MS = 60 * 1000;
const MAX_PER_EMAIL_PER_DAY = 5;
const IP_BUDGET_MAX = 10;
const IP_BUDGET_WINDOW_MS = 10 * 60 * 1000;

// Per-IP fixed window (the codebase's rate-limit convention: in-memory, per
// process — correct on the single box; a multi-instance deploy needs a shared
// store). Applied uniformly before any branch.
@Injectable()
export class SignupBudget {
  private readonly windows = new Map<string, { start: number; count: number }>();
  allow(key: string, now: number): boolean {
    const w = this.windows.get(key);
    if (w === undefined || now - w.start >= IP_BUDGET_WINDOW_MS) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= IP_BUDGET_MAX) return false;
    w.count += 1;
    return true;
  }
  reset(): void {
    this.windows.clear();
  }
}

export function signupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SIGN_PUBLIC_SIGNUP_ENABLED'] === '1';
}

export function hashSignupToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('base64url');
}

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Sign Unified Product S-2 — the one Sign base URL (same resolution as
// libs/sign signBaseUrl; inlined: platform-admin does not depend on @aramo/sign).
function consoleBase(): string {
  for (const key of ['ARAMO_SIGN_BASE_URL', 'SIGN_WEB_BASE_URL', 'SIGN_SENDER_WEB_BASE_URL']) {
    const v = process.env[key]?.trim();
    if (v !== undefined && v !== '') return v.replace(/\/+$/, '');
  }
  return 'https://sign.aramo.ai';
}

function invalidLink(requestId: string): AramoError {
  // One answer for unknown / expired / superseded / over budget (no oracle).
  return new AramoError('NOT_FOUND', 'This signup link is invalid or has expired', 404, { requestId });
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length === 0 || t.length > max ? null : t;
}

export interface CompleteResult {
  status: 'PROVISIONED' | 'PROVISIONING';
  email: string;
  organization_name: string;
  sign_in_url: string;
  // Federated sign-in entry points (AUTH-SIGNIN-1 `idp` hint) for the done page.
  sign_in: { microsoft: string; google: string };
}

/** The sign host's federated sign-in links (the auth-service login on that host). */
export function federatedSignInLinks(): { microsoft: string; google: string } {
  const base = consoleBase();
  return {
    microsoft: `${base}/auth/sign/login?idp=microsoft&return_to=%2F`,
    google: `${base}/auth/sign/login?idp=google&return_to=%2F`,
  };
}

@Injectable()
export class SignSignupService {
  private readonly log = new Logger(SignSignupService.name);

  constructor(
    private readonly requests: SignupRequestRepository,
    private readonly identityRepo: IdentityRepository,
    private readonly tenants: TenantRepository,
    private readonly identity: IdentityService,
    private readonly tenantSvc: TenantService,
    private readonly entitlements: EntitlementRepository,
    private readonly idpPolicy: IdentityProviderPolicyService,
    // Sign Signup Amendment A1 (LOCKED) — the US billing-region lock and the
    // signer's authority attestation, written in the provisioning saga.
    private readonly region: OrganizationRegionService,
    @Inject(MAILER_PORT) private readonly mailer: MailerPort,
    private readonly budget: SignupBudget,
    // A1 — signup terms evidence (versioned registry; nothing approved yet).
    private readonly acceptances: LegalAcceptanceService,
    @Optional() @Inject(LEGAL_DOCUMENT_REGISTRY) legal?: readonly LegalDocumentVersion[],
  ) {
    this.legal = legal ?? LEGAL_DOCUMENTS;
  }

  private readonly legal: readonly LegalDocumentVersion[];

  /** The terms a signup must accept — null while no version is APPROVED (no unapproved terms are ever presented). */
  currentTerms(): { version: string; url: string } | null {
    const t = approvedLegalDocument('sign.terms_of_service', this.legal);
    return t === null || t.url === null ? null : { version: t.version, url: t.url };
  }

  async start(input: { email?: unknown; organization_name?: unknown; display_name?: unknown; accept_terms?: unknown; ip: string; request_id: string; now?: Date }): Promise<void> {
    const now = input.now ?? new Date();
    const email = cleanText(input.email, 254);
    const organization_name = cleanText(input.organization_name, 100);
    const display_name = input.display_name === undefined || input.display_name === null || input.display_name === '' ? null : cleanText(input.display_name, 100);
    if (email === null || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || organization_name === null || organization_name.length < 2 || (input.display_name && display_name === null)) {
      throw new AramoError('VALIDATION_ERROR', 'Enter your work email, your organization name and your name', 400, { requestId: input.request_id });
    }
    const terms = approvedLegalDocument('sign.terms_of_service', this.legal);
    const terms_ref = terms === null ? null : legalRef(terms);
    if (terms !== null && input.accept_terms !== true) {
      throw new AramoError('VALIDATION_ERROR', 'Accept the terms to continue', 400, { requestId: input.request_id, details: { reason: 'terms_not_accepted' } });
    }
    const normalized = normalizeEmail(email);
    // BUSINESS only: a personal / disposable address is a form error (this says
    // nothing about whether the address has an account).
    if (isPersonalOrDisposableDomain(extractEmailDomain(normalized))) {
      throw new AramoError('VALIDATION_ERROR', 'Use your work email address', 400, { requestId: input.request_id, details: { reason: 'business_email_required' } });
    }
    // Everything below answers the same 202, whatever happens.
    if (!this.budget.allow(`ip:${input.ip}`, now.getTime())) return;
    const latest = await this.requests.latestForEmail(normalized);
    if (latest !== null && now.getTime() - latest.created_at.getTime() < RESEND_GAP_MS) return;
    if ((await this.requests.countSince(normalized, new Date(now.getTime() - LINK_TTL_MS))) >= MAX_PER_EMAIL_PER_DAY) return;

    const existing = await this.identity.findUserByEmail(normalized);
    if (existing !== null) {
      await this.send(normalized, 'You already have an Aramo account', [
        'Someone (hopefully you) tried to create a new Aramo Sign organization with this email address.',
        'This address already belongs to an Aramo account, so no new organization was created. Sign in instead.',
      ], { label: 'Sign in to Aramo Sign', href: `${consoleBase()}/login` });
      return;
    }

    const raw = randomBytes(32).toString('base64url');
    await this.requests.create({
      email: normalized,
      organization_name,
      display_name,
      token_hash: hashSignupToken(raw),
      expires_at: new Date(now.getTime() + LINK_TTL_MS),
      terms_ref,
      now,
    });
    // The token travels in the URL fragment: it never reaches a server log or a
    // Referer header; the page posts it to complete.
    await this.send(normalized, 'Confirm your email to create your Aramo Sign organization', [
      `Confirm this address to create ${organization_name} on Aramo Sign.`,
      'The link works for 24 hours. If you didn’t ask for this, ignore this email — nothing has been created.',
    ], { label: 'Confirm and create organization', href: `${consoleBase()}/signup/verify#token=${raw}` });
  }

  /** What the verify page shows before the owner confirms (no state change). */
  async preview(token: unknown, requestId: string, now: Date = new Date()): Promise<{ email: string; organization_name: string; display_name: string | null; status: string }> {
    const row = await this.lookup(token, requestId, now);
    return { email: row.email, organization_name: row.organization_name, display_name: row.display_name, status: row.status === 'PROVISIONED' ? 'PROVISIONED' : 'READY' };
  }

  /** A1 §2.3 — the verify page may only use address search with a live, unprovisioned link. */
  async assertLiveLink(token: unknown, requestId: string, now: Date = new Date()): Promise<void> {
    const row = await this.lookup(token, requestId, now);
    if (row.status === 'PROVISIONED') throw invalidLink(requestId);
  }

  async complete(input: { token?: unknown; organization_name?: unknown; organization?: unknown; ip: string; request_id: string; now?: Date }): Promise<CompleteResult> {
    const now = input.now ?? new Date();
    if (!this.budget.allow(`ip:${input.ip}`, now.getTime())) throw invalidLink(input.request_id);
    const row = await this.lookup(input.token, input.request_id, now);
    const signInUrl = `${consoleBase()}/login`;
    const sign_in = federatedSignInLinks();
    if (row.status === 'PROVISIONED') {
      return { status: 'PROVISIONED', email: row.email, organization_name: row.organization_name, sign_in_url: signInUrl, sign_in };
    }
    // Sign Signup Amendment A1 (LOCKED) §2 — the organization details and the
    // signer's authority attestation are required, and validated (US only:
    // 50 states + DC), BEFORE anything is claimed or created.
    const organization = validateUsOrganizationDetails(input.organization, input.request_id);
    if ((input.organization as { authority_attested?: unknown }).authority_attested !== true) {
      throw new AramoError('VALIDATION_ERROR', 'Confirm that you are authorized to act for the organization', 400, {
        requestId: input.request_id,
        details: { reason: 'authority_attestation_required', field: 'authority_attested' },
      });
    }
    const rename = input.organization_name === undefined ? null : cleanText(input.organization_name, 100);
    if (input.organization_name !== undefined && (rename === null || rename.length < 2)) {
      throw new AramoError('VALIDATION_ERROR', 'Enter an organization name', 400, { requestId: input.request_id });
    }
    const organization_name = rename ?? row.organization_name;
    if (!(await this.requests.claim(row.id, now))) {
      return { status: 'PROVISIONING', email: row.email, organization_name, sign_in_url: signInUrl, sign_in };
    }

    try {
      const res = await this.provisionFederatedOwner({
        name: organization_name,
        owner_email: row.email,
        owner_display_name: row.display_name,
        request_id: input.request_id,
        organization,
        signup_request_id: row.id,
        ip: input.ip,
        at: now,
      });
      await this.requests.markProvisioned(row.id, res.tenant_id, res.owner_user_id, new Date());
      await this.recordSignupTerms(row, res.tenant_id, res.owner_user_id);
      this.log.log(`self-service signup provisioned tenant ${res.tenant_id}`);
      await this.sendReady(row.email, organization_name, sign_in);
      return { status: 'PROVISIONED', email: row.email, organization_name, sign_in_url: signInUrl, sign_in };
    } catch (err) {
      const code = err instanceof AramoError ? err.code : 'INTERNAL_ERROR';
      if (code === 'EMAIL_UNAVAILABLE' || code === 'TENANT_ALREADY_EXISTS') {
        // A previous attempt may have finished the saga and died before recording
        // it (the saga's name / email pre-checks then refuse): adopt the tenant
        // only if it is this request's own (created after it, with this name,
        // owned by this address as its only membership).
        const adopted = await this.adopt(row, organization_name);
        if (adopted !== null) {
          // The crashed attempt wrote the profile in the tenant insert; make sure
          // its lock and attestation exist too (both idempotent).
          await this.region.lockUs(adopted.tenant_id);
          await this.region.recordAttestation(this.attestationFor(adopted.tenant_id, row.id, row.email, organization, input.ip, now));
          await this.requests.markProvisioned(row.id, adopted.tenant_id, adopted.user_id, new Date());
          await this.recordSignupTerms(row, adopted.tenant_id, adopted.user_id);
          return { status: 'PROVISIONED', email: row.email, organization_name, sign_in_url: signInUrl, sign_in };
        }
      }
      await this.requests.markFailed(row.id, code, new Date());
      if (code === 'TENANT_ALREADY_EXISTS') {
        throw new AramoError('TENANT_ALREADY_EXISTS', 'An organization with this name already exists on Aramo. Choose another name.', 409, {
          requestId: input.request_id,
          details: { reason: 'organization_name_taken' },
        });
      }
      if (code === 'EMAIL_UNAVAILABLE') {
        throw new AramoError('EMAIL_UNAVAILABLE', 'This email address already belongs to an Aramo account. Sign in instead.', 409, { requestId: input.request_id });
      }
      if (code === 'VALIDATION_ERROR') throw err;
      this.log.error(`self-service signup failed (${code}): ${(err as Error).message}`);
      throw new AramoError('INTERNAL_ERROR', 'We couldn’t finish creating your organization. Try the link again in a minute.', 500, {
        requestId: input.request_id,
        details: { retryable: true },
      });
    }
  }

  /**
   * Cognito-free provisioning of a Sign Business tenant and its owner. Order:
   * tenant → enforced-pin enrollment (so the tenant never exists without its
   * pin rule) → capabilities → owner (tenant_owner + tenant_admin — ROLES-1 PR-2 §6;
   * formerly org_admin — ACTIVE, no ExternalIdentity).
   * A failure after the tenant exists soft-disables it (inert), as the
   * platform saga does; the request is marked FAILED and can be retried.
   */
  private async provisionFederatedOwner(args: {
    name: string;
    owner_email: string;
    owner_display_name: string | null;
    request_id: string;
    organization: UsOrganizationDetails;
    signup_request_id: string;
    ip: string;
    at: Date;
  }): Promise<{ tenant_id: string; owner_user_id: string }> {
    // Pre-checks before any write (same refusals as the platform saga).
    if ((await this.tenantSvc.findByNameCaseInsensitive(args.name)) !== null) {
      throw new AramoError('TENANT_ALREADY_EXISTS', 'A tenant with this name already exists', 409, { requestId: args.request_id });
    }
    if ((await this.identity.findUserByEmail(normalizeEmail(args.owner_email))) !== null) {
      throw new AramoError('EMAIL_UNAVAILABLE', 'This email address is not available', 409, { requestId: args.request_id, details: {} });
    }
    // ROLES-1 PR-2 (Directive v1.0 LOCKED §6; Conforming Amendment 5) — the signup
    // owner receives the organization roles tenant_owner + tenant_admin.
    const role_ids = await this.identity.resolveRoleIdsByKeys([...SIGN_SIGNUP_OWNER_ROLE_KEYS]);
    const tenant = await this.tenantSvc.provisionTenant({
      name: args.name,
      owner_email: args.owner_email,
      actor_user_id: SIGN_SIGNUP_SYSTEM_ACTOR_ID,
      invitation_sent: false,
      kind: 'BUSINESS',
      audit_source: SIGN_SIGNUP_AUDIT_SOURCE,
      actor_type: 'system',
      // A1 §2.2 — the organization profile, in the same insert as the tenant.
      profile: profileFields(args.organization),
    });
    const disable = async (reason: string) => {
      await this.tenantSvc
        .deactivateTenant({ tenant_id: tenant.id, actor_user_id: SIGN_SIGNUP_SYSTEM_ACTOR_ID, reason, actor_type: 'system' })
        .catch((e: unknown) => this.log.error(`soft-disable of ${tenant.id} failed: ${(e as Error).message}`));
    };
    try {
      await this.idpPolicy.enrollEnforcedTenant(tenant.id);
      await this.entitlements.grantCapabilities({ tenant_id: tenant.id, capabilities: [...SIGN_CAPABILITIES] });
      const owner = await this.identity.createFederatedOwnerNoSub({
        email: args.owner_email,
        display_name: args.owner_display_name,
        tenant_id: tenant.id,
        role_keys: [...SIGN_SIGNUP_OWNER_ROLE_KEYS],
        role_ids,
        actor_user_id: SIGN_SIGNUP_SYSTEM_ACTOR_ID,
        request_id: args.request_id,
        // ROLES-1 PR-1/PR-2 (§4.2) — a system provisioning path may grant tenant_owner.
        owner_role_authority: 'system',
      });
      // A1 §2.4/§2.5 — hold the profile to the US; record the signer's attestation.
      await this.region.lockUs(tenant.id);
      await this.region.recordAttestation(this.attestationFor(tenant.id, args.signup_request_id, args.owner_email, args.organization, args.ip, args.at));
      return { tenant_id: tenant.id, owner_user_id: owner.user.id };
    } catch (err) {
      await disable('sign_signup_provisioning_failed');
      throw err;
    }
  }

  private attestationFor(tenant_id: string, signup_request_id: string, email: string, o: UsOrganizationDetails, ip: string, at: Date) {
    return {
      tenant_id,
      signup_request_id,
      signer_email: email,
      signer_name: o.primary_contact_name,
      signer_title: o.signer_title,
      organization_legal_name: o.legal_name,
      ip: ip === 'unknown' ? null : ip,
      attested_at: at,
    };
  }

  private async sendReady(to: string, organization_name: string, links: { microsoft: string; google: string }): Promise<void> {
    await this.send(
      to,
      'Your Aramo Sign organization is ready',
      [
        `${organization_name} is set up on Aramo Sign.`,
        'Sign in with the Microsoft or Google work account for this email address. The provider you sign in with first becomes your organization\u2019s sign-in provider.',
        `Continue with Google: ${links.google}`,
        'After you sign in, choose a plan to start sending documents.',
      ],
      { label: 'Continue with Microsoft', href: links.microsoft },
    );
  }

  // A1 — the accepted terms version (stored on the request at start) becomes an
  // acceptance record for the new tenant. Failure is logged, never undoes the
  // tenant (the request row keeps terms_ref as the primary evidence).
  private async recordSignupTerms(row: { id: string; email: string; terms_ref: string | null; created_at: Date }, tenant_id: string, user_id: string): Promise<void> {
    if (row.terms_ref === null) return;
    const doc = this.legal.find((d) => legalRef(d) === row.terms_ref);
    if (doc === undefined) {
      this.log.warn(`signup ${row.id}: accepted terms ${row.terms_ref} not in the registry`);
      return;
    }
    try {
      await this.acceptances.record({ document: doc, context: 'SIGNUP', context_ref: row.id, tenant_id, user_id, subject_email: row.email, accepted_at: row.created_at });
    } catch (err) {
      this.log.error(`signup ${row.id}: terms acceptance not recorded: ${(err as Error).message}`);
    }
  }

  private async lookup(token: unknown, requestId: string, now: Date) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw invalidLink(requestId);
    const row = await this.requests.findByTokenHash(hashSignupToken(token));
    if (row === null || row.status === 'SUPERSEDED') throw invalidLink(requestId);
    if (row.status !== 'PROVISIONED' && row.expires_at.getTime() <= now.getTime()) throw invalidLink(requestId);
    return row;
  }

  private async adopt(row: { email: string; created_at: Date }, organization_name: string): Promise<{ tenant_id: string; user_id: string } | null> {
    const user = await this.identity.findUserByEmail(row.email);
    if (user === null) return null;
    const tenantIds = await this.identityRepo.findMembershipTenantIdsForUser(user.id);
    if (tenantIds.length !== 1) return null;
    const tenant_id = tenantIds[0]!;
    // The saga's owner role (tenant_owner — ROLES-1 PR-2; a pre-ROLES-1 org_admin owner
    // was renamed tenant_admin and granted tenant_owner by the §5.2 step 4
    // reconciliation), on this address's membership.
    const membership = await this.identityRepo.findMembership({ user_id: user.id, tenant_id });
    if (membership === null || !(await this.identity.findRoleKeysForMembership(membership.id)).includes('tenant_owner')) return null;
    const tenant = await this.tenants.findById(tenant_id);
    if (tenant === null || tenant.name.toLowerCase() !== organization_name.toLowerCase() || new Date(tenant.created_at).getTime() < row.created_at.getTime()) return null;
    return { tenant_id: tenant.id, user_id: user.id };
  }

  private async send(to: string, subject: string, lines: string[], action: { label: string; href: string }): Promise<void> {
    const html = [
      '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827">',
      '<div style="font-weight:700;font-size:18px;margin-bottom:16px">Aramo Sign</div>',
      ...lines.map((l) => `<p style="line-height:1.5">${esc(l)}</p>`),
      `<p style="margin:24px 0"><a href="${esc(action.href)}" style="background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${esc(action.label)}</a></p>`,
      '</div>',
    ].join('');
    try {
      await this.mailer.send({ to, subject, html, text: `${lines.join('\n\n')}\n\n${action.label}: ${action.href}` });
    } catch (err) {
      // The start answer stays the same; the person can ask again after the gap.
      this.log.error(`signup email failed: ${(err as Error).message}`);
    }
  }
}

/** A1 §2.2 — the validated details as tenant profile columns. */
export function profileFields(o: UsOrganizationDetails): Record<string, string | null> {
  return {
    legal_name: o.legal_name,
    address_line1: o.address_line1,
    address_line2: o.address_line2,
    city: o.city,
    state_province: o.state_province,
    postal_code: o.postal_code,
    country_code: o.country_code,
    primary_contact_name: o.primary_contact_name,
    primary_contact_email: o.primary_contact_email,
    primary_contact_phone: o.primary_contact_phone,
    tax_id: o.tax_id,
    registration_number: o.registration_number,
  };
}
