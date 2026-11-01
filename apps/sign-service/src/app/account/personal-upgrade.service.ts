import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import {
  BUSINESS_OWNER_ROLE_KEYS,
  IdentityRepository,
  IdentityService,
  PersonalRiskService,
  PersonalUpgradeRepository,
  TENANT_OWNER_ROLE_KEY,
  TenantRepository,
  restrictionInForce,
  validateUsOrganizationDetails,
  type UsOrganizationDetails,
} from '@aramo/identity';
import {
  FreePersonalSubscriptionService,
  LEGAL_CLOCK,
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_REGISTRY,
  LegalAcceptanceService,
  SIGN_PRODUCT_KEY,
  effectiveLegalDocument,
  legalRef,
  systemLegalClock,
  type LegalClock,
  type LegalDocumentVersion,
} from '@aramo/subscription';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §5 "Related work" — the
// Personal → Business upgrade (recon: doc/backlog/sign-personal-to-business-upgrade-recon.md).
//
// The signed-in OWNER of a PERSONAL account turns it into a Business organization IN
// PLACE: the tenant id does not change, so its envelopes, evidence, ledger hash chain,
// custody object keys (tenants/<tenant>/…) and retention setting all stay as they are.
// Dark: unless SIGN_PERSONAL_UPGRADE_ENABLED=1 both routes answer 404 (as if absent) and
// sign-web hides the card.
//
//   GET  v1/sign/account/upgrade   eligibility, the Business terms to accept, the plan
//   POST v1/sign/account/upgrade   { confirm: 'UPGRADE', organization_name, organization,
//                                    accept_terms: true } → { state: 'upgraded', … }
//
// The POST, in order:
//   1. every check below (nothing is written before all of them pass);
//   2. the Business terms acceptance (context IN_APP, idempotent per user and version);
//   3. the FREE subscription ends (billing lock; no billing provider is called);
//   4. ONE identity transaction (PersonalUpgradeRepository): kind PERSONAL → BUSINESS
//      (compare-and-set), organization name + profile, US region lock, authority
//      attestation, tenant_admin added to the owner, authorization version bump, audit
//      identity.tenant.upgraded_to_business.
// If step 4 fails the account is still PERSONAL and its FREE subscription reopens on
// the next read (FreePersonalSubscriptionService.ensure). The upgrade is irreversible.
// After it the organization has no subscription: the owner chooses a Business plan on
// the existing Billing page, exactly as after a new Business signup.
//
// Personal-only restrictions are all derived from Tenant.kind at request time (send gate,
// Personal legal re-acceptance, abuse-report pause, personal workspace) or carried by the
// FREE plan (monthly / daily caps, storage, no invites), so steps 3 and 4 lift them.
//
// Refusals (stable details.reason):
//   upgrade_confirmation_required          400  body.confirm is not exactly 'UPGRADE'
//   terms_not_accepted                     400  accept_terms is not true
//   authority_attestation_required         400  organization.authority_attested is not true
//   (organization field errors)            400  validateUsOrganizationDetails (US only)
//   invalid_organization_name              400  2–100 characters
//   not_personal_account                   403  the tenant is already BUSINESS
//   not_account_owner                      403  the caller does not hold tenant_owner
//   personal_account_not_active            403  the account is not ACTIVE (not yet bound / closed)
//   personal_account_not_in_good_standing  403  no risk state, or review / restriction / closed
//   business_terms_not_available           403  no APPROVED, effective Business terms in the registry
//   personal_paid_subscription_upgrade_unsupported 403 an open subscription that is not FREE
//   organization_name_taken                409  (TENANT_ALREADY_EXISTS) another organization already uses the name

export const UPGRADE_CONFIRMATION = 'UPGRADE';
export const BUSINESS_TERMS_KEY = 'sign.terms_of_service' as const;
const NAME_MAX = 100;

export function personalUpgradeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SIGN_PERSONAL_UPGRADE_ENABLED'] === '1';
}

export type UpgradeIneligibility =
  | 'not_personal_account'
  | 'not_account_owner'
  | 'personal_account_not_active'
  | 'personal_account_not_in_good_standing'
  | 'business_terms_not_available'
  | 'personal_paid_subscription_upgrade_unsupported';

export interface PersonalUpgradeStatus {
  eligible: boolean;
  reason: UpgradeIneligibility | null;
  current_name: string;
  terms: { key: string; version: string; url: string } | null;
  subscription: { plan_key: string; source: string } | null;
}

export interface PersonalUpgradeResult {
  state: 'upgraded';
  kind: 'BUSINESS';
  organization_name: string;
  upgraded_at: string;
}

const STATUS: Record<UpgradeIneligibility, { code: 'INSUFFICIENT_PERMISSIONS'; status: number; message: string }> = {
  not_personal_account: { code: 'INSUFFICIENT_PERMISSIONS', status: 403, message: 'This account is already a business organization' },
  not_account_owner: { code: 'INSUFFICIENT_PERMISSIONS', status: 403, message: 'Only the account owner can upgrade this account' },
  personal_account_not_active: { code: 'INSUFFICIENT_PERMISSIONS', status: 403, message: 'This account cannot be upgraded until it is active' },
  personal_account_not_in_good_standing: { code: 'INSUFFICIENT_PERMISSIONS', status: 403, message: 'This account cannot be upgraded while it is under review, restricted or closed' },
  business_terms_not_available: { code: 'INSUFFICIENT_PERMISSIONS', status: 403, message: 'Business upgrades are not available yet' },
  personal_paid_subscription_upgrade_unsupported: { code: 'INSUFFICIENT_PERMISSIONS', status: 403, message: 'An account with a paid plan cannot be upgraded here yet. Contact Aramo.' },
};

function refusal(reason: UpgradeIneligibility, requestId: string): AramoError {
  const s = STATUS[reason];
  return new AramoError(s.code, s.message, s.status, { requestId, details: { reason } });
}

function bad(message: string, reason: string, requestId: string, field?: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, details: { reason, ...(field !== undefined ? { field } : {}) } });
}

function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length < 2 || t.length > NAME_MAX ? null : t;
}

/** The validated organization details as tenant profile columns (Sign Signup A1 §2.2). */
export function upgradeProfileFields(o: UsOrganizationDetails): Record<string, string | null> {
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

@Injectable()
export class PersonalUpgradeService {
  private readonly log = new Logger(PersonalUpgradeService.name);
  private readonly legal: readonly LegalDocumentVersion[];
  private readonly clock: LegalClock;

  constructor(
    private readonly tenants: TenantRepository,
    private readonly repo: IdentityRepository,
    private readonly identity: IdentityService,
    private readonly risk: PersonalRiskService,
    private readonly upgrades: PersonalUpgradeRepository,
    private readonly free: FreePersonalSubscriptionService,
    private readonly acceptances: LegalAcceptanceService,
    @Optional() @Inject(LEGAL_DOCUMENT_REGISTRY) legal?: readonly LegalDocumentVersion[],
    @Optional() @Inject(LEGAL_CLOCK) clock?: LegalClock,
  ) {
    this.legal = legal ?? LEGAL_DOCUMENTS;
    this.clock = clock ?? systemLegalClock;
  }

  /** 404 while the upgrade is switched off (the routes behave as if absent). */
  assertEnabled(requestId: string): void {
    if (!personalUpgradeEnabled()) throw new AramoError('NOT_FOUND', 'Not found', 404, { requestId });
  }

  /** The Business terms in effect now (null while none is APPROVED and effective). */
  businessTerms(now: Date = this.clock()): LegalDocumentVersion | null {
    const d = effectiveLegalDocument(BUSINESS_TERMS_KEY, this.legal, now);
    return d === null || d.url === null ? null : d;
  }

  async status(auth: Pick<AuthContextType, 'tenant_id' | 'sub'>, requestId: string): Promise<PersonalUpgradeStatus> {
    this.assertEnabled(requestId);
    const tenant = await this.tenants.findById(auth.tenant_id);
    const terms = this.businessTerms();
    const open = await this.free.openBaseOf(auth.tenant_id, SIGN_PRODUCT_KEY);
    const reason = tenant === null ? 'not_personal_account' : await this.ineligibility(tenant, auth.sub, open, terms);
    return {
      eligible: reason === null,
      reason,
      current_name: tenant?.name ?? '',
      terms: terms === null ? null : { key: terms.key, version: terms.version, url: terms.url! },
      subscription: open === null ? null : { plan_key: open.plan_key, source: open.source },
    };
  }

  async upgrade(
    auth: Pick<AuthContextType, 'tenant_id' | 'sub'>,
    body: { confirm?: unknown; organization_name?: unknown; organization?: unknown; accept_terms?: unknown } | undefined,
    meta: { ip: string | null; request_id: string },
  ): Promise<PersonalUpgradeResult> {
    const requestId = meta.request_id;
    this.assertEnabled(requestId);
    if (body?.confirm !== UPGRADE_CONFIRMATION) throw bad('Type UPGRADE to confirm the upgrade', 'upgrade_confirmation_required', requestId);
    const organization_name = cleanName(body.organization_name);
    if (organization_name === null) throw bad('Enter an organization name (2 to 100 characters)', 'invalid_organization_name', requestId, 'organization_name');
    const organization = validateUsOrganizationDetails(body.organization, requestId);
    if ((body.organization as { authority_attested?: unknown }).authority_attested !== true) {
      throw bad('Confirm that you are authorized to act for the organization', 'authority_attestation_required', requestId, 'authority_attested');
    }
    if (body.accept_terms !== true) throw bad('Accept the business terms to continue', 'terms_not_accepted', requestId, 'accept_terms');

    const tenant = await this.tenants.findById(auth.tenant_id);
    if (tenant === null) throw refusal('not_personal_account', requestId);
    const terms = this.businessTerms();
    const open = await this.free.openBaseOf(auth.tenant_id, SIGN_PRODUCT_KEY);
    const reason = await this.ineligibility(tenant, auth.sub, open, terms);
    if (reason !== null) throw refusal(reason, requestId);
    const taken = await this.tenants.findByNameCaseInsensitive(organization_name);
    if (taken !== null && taken.id !== tenant.id) {
      throw new AramoError('TENANT_ALREADY_EXISTS', 'An organization with this name already exists on Aramo. Choose another name.', 409, {
        requestId,
        details: { reason: 'organization_name_taken' },
      });
    }
    const membership = await this.repo.findMembership({ user_id: auth.sub, tenant_id: auth.tenant_id });
    const user = await this.identity.findUserById(auth.sub);
    if (membership === null || user === null) throw refusal('not_account_owner', requestId);
    const role_ids = await this.identity.resolveRoleIdsByKeys([...BUSINESS_OWNER_ROLE_KEYS]);
    const now = this.clock();

    // 2 — the Business terms acceptance (evidence precedes the change it authorizes).
    await this.acceptances.recordInApp({
      document: terms!,
      tenant_id: tenant.id,
      user_id: auth.sub,
      subject_email: user.email,
      ip: meta.ip,
      user_agent: null,
      accepted_at: now,
    });
    // 3 — the FREE subscription ends (a concurrent paid row is refused, nothing changes).
    const ended = await this.free.endForBusinessUpgrade({ tenant_id: tenant.id, product_key: SIGN_PRODUCT_KEY, at: now });
    if ('refused' in ended) throw refusal('personal_paid_subscription_upgrade_unsupported', requestId);
    // 4 — the identity half, one transaction.
    const outcome = await this.upgrades.upgradeToBusiness({
      tenant_id: tenant.id,
      owner_user_id: auth.sub,
      membership_id: membership.id,
      organization_name,
      profile: upgradeProfileFields(organization),
      attestation: {
        signer_email: user.email,
        signer_name: organization.primary_contact_name,
        signer_title: organization.signer_title,
        organization_legal_name: organization.legal_name,
        ip: meta.ip,
      },
      owner_role_ids: role_ids,
      terms_ref: legalRef(terms!),
      ended_subscription: ended.ended,
      request_id: requestId,
      now,
    });
    if (!outcome.upgraded) throw refusal('not_personal_account', requestId);
    this.log.log(`personal tenant ${tenant.id} upgraded to business`);
    return { state: 'upgraded', kind: 'BUSINESS', organization_name, upgraded_at: now.toISOString() };
  }

  private async ineligibility(
    tenant: { id: string; kind: string; status: string },
    user_id: string,
    open: { source: string } | null,
    terms: LegalDocumentVersion | null,
  ): Promise<UpgradeIneligibility | null> {
    if (tenant.kind !== 'PERSONAL') return 'not_personal_account';
    if (!(await this.isOwner(tenant.id, user_id))) return 'not_account_owner';
    if (tenant.status !== 'ACTIVE') return 'personal_account_not_active';
    const state = await this.risk.riskStateOf(tenant.id);
    if (state === null || state.state !== 'clear' || state.review_pending || restrictionInForce(state, this.clock())) {
      return 'personal_account_not_in_good_standing';
    }
    if (terms === null) return 'business_terms_not_available';
    if (open !== null && open.source !== 'FREE') return 'personal_paid_subscription_upgrade_unsupported';
    return null;
  }

  private async isOwner(tenant_id: string, user_id: string): Promise<boolean> {
    const membership = await this.repo.findMembership({ user_id, tenant_id });
    if (membership === null || membership.is_active === false) return false;
    return (await this.identity.findRoleKeysForMembership(membership.id)).includes(TENANT_OWNER_ROLE_KEY);
  }
}
