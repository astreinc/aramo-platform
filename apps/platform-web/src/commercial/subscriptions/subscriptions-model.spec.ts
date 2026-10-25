import { ApiError } from '@aramo/fe-foundation';
import { describe, expect, it } from 'vitest';

import { diffRows, payloadOf, planChoices, priceLabel } from './TenantCommercialDialogs';
import {
  NO_FILTER,
  allowanceBar,
  commitmentCell,
  crRef,
  insideCommitment,
  passesFilter,
  periodText,
  provenanceText,
  refusalLine,
  needsRelease,
  releaseState,
  rowFlags,
  segmentCounts,
  sourceBadge,
  statusView,
  tenantActions,
  versionText,
  type ActionContext,
} from './subscriptions-model';
import { CATALOG, CONTRACT, NOW, PV_TEAM_2, STRIPE_ROW, SUB_MERIDIAN, entitlement, facts, heldFlag, openRequest, product, row } from './subscriptions-test-data';

// CCP-B3 — the pure half of the workbench and the Tenant › Commercial tab (CCP-UI v1.0 handoff
// §5.3, §5.9): status / grace / suspension, periods, commitment, source badge, flags, filters,
// provenance, the actions with their gating and domain reasons, the request payloads (the
// action-to-change-request trace) and the refusal lines.

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({ product: product(), canSubscription: true, canEntitlement: true, canSupport: false, human: true, now: NOW, ...over });
const byKey = (c: ActionContext) => Object.fromEntries(tenantActions(c).map((a) => [a.key, a]));

describe('CCP-B3 status, period, commitment (handoff §5.3)', () => {
  it('B3-M-1 active, past due in grace, suspended after grace, past due without a date, ended', () => {
    expect(statusView(facts(), NOW)).toEqual({ segments: ['ACTIVE'], label: 'Active', tone: 'ok', line: '' });
    expect(statusView(facts({ status: 'PAST_DUE', grace_until: '2026-10-29T00:00:00.000Z' }), NOW)).toEqual({ segments: ['PAST_DUE', 'GRACE'], label: 'Past due · in grace', tone: 'warn', line: 'Grace ends 29 Oct 2026 (in 4 d)' });
    expect(statusView(facts({ status: 'PAST_DUE', grace_until: '2026-10-15T00:00:00.000Z' }), NOW)).toEqual({ segments: ['SUSPENDED'], label: 'Suspended', tone: 'danger', line: 'Suspended 15 Oct 2026 after grace' });
    expect(statusView(facts({ status: 'PAST_DUE', grace_until: null }), NOW).segments).toEqual(['PAST_DUE']);
    expect(statusView(facts({ ended_at: '2026-10-18T00:00:00.000Z', status: 'CANCELED' }), NOW)).toEqual({ segments: ['ENDED'], label: 'Ended', tone: 'muted', line: 'Ended 18 Oct 2026' });
  });

  it('B3-M-2 the period shows its inclusive last day; an ended row shows its last period', () => {
    expect(periodText(facts())).toBe('15 Oct 2026 – 14 Nov 2026');
    expect(periodText(facts({ current_period: null, ended_at: '2026-10-18T00:00:00.000Z', period_anchor: '2024-10-18T00:00:00.000Z' }))).toBe('18 Sep 2026 – 17 Oct 2026');
    expect(periodText(facts({ current_period: null, ended_at: null }))).toBe('—');
  });

  it('B3-M-3 commitment end: in n days, ended, none (self-service: "No commitment")', () => {
    expect(commitmentCell(facts(), NOW)).toEqual({ date: '14 Mar 2027', rel: 'in 140 days' });
    expect(commitmentCell(facts({ commitment_end: '2026-10-17T00:00:00.000Z' }), NOW).rel).toBe('Ended');
    expect(commitmentCell(STRIPE_ROW(), NOW)).toEqual({ date: '—', rel: 'No commitment' });
    expect(commitmentCell(facts({ commitment_end: null }), NOW)).toEqual({ date: '—', rel: '' });
  });

  it('B3-M-4 version (grandfathered when retired), source badge (Managed in Stripe / MANUAL · contract)', () => {
    expect(versionText(facts())).toBe('v1');
    expect(versionText(facts({ plan_version: { id: 'x', version_number: 1, status: 'RETIRED' } }))).toBe('v1 · grandfathered');
    expect(sourceBadge(STRIPE_ROW())).toEqual({ label: 'Managed in Stripe', stripe: true });
    expect(sourceBadge(facts())).toEqual({ label: 'MANUAL · CT-2025-014', stripe: false });
    expect(sourceBadge(facts(), true)).toEqual({ label: 'MANUAL · contract', stripe: false });
    expect(sourceBadge(facts({ contract: null }))).toEqual({ label: 'MANUAL · contract', stripe: false });
  });

  it('B3-M-5 flags: the held activation (Conversion Rule C-8) and an active overlay', () => {
    expect(rowFlags(facts())).toEqual([]);
    expect(rowFlags(facts({ open_flags: ['governed_subscription_open'], active_extensions: { count: 1, exception: true } }))).toEqual([
      { label: 'Reconciliation flag', kind: 'recon' },
      { label: 'Extension · exception', kind: 'exception' },
    ]);
  });
});

describe('CCP-B3 workbench filters (handoff §5.3)', () => {
  const rows = [
    row(),
    row({ subscription_id: 'b', source: 'SELF_SERVICE', status: 'PAST_DUE', grace_until: '2026-10-29T00:00:00.000Z', commitment_end: null, open_flags: ['governed_subscription_open'] }),
    row({ subscription_id: 'c', status: 'PAST_DUE', grace_until: '2026-10-15T00:00:00.000Z', commitment_end: '2026-11-10T00:00:00.000Z' }),
    row({ subscription_id: 'd', ended_at: '2026-10-18T00:00:00.000Z', plan_version: { id: PV_TEAM_2, version_number: 2, status: 'PUBLISHED' } }),
  ];
  it('B3-M-6 segment counts under the other filters (in grace also counts as past due)', () => {
    expect(segmentCounts(rows, NO_FILTER, NOW)).toEqual({ all: 4, ACTIVE: 1, PAST_DUE: 1, GRACE: 1, SUSPENDED: 1, ENDED: 1 });
    expect(segmentCounts(rows, { ...NO_FILTER, source: 'SELF_SERVICE' }, NOW).all).toBe(1);
  });
  it('B3-M-7 each filter: status, source, version, commitment window, reconciliation flag', () => {
    const pass = (f: Partial<typeof NO_FILTER>) => rows.filter((r) => passesFilter(r, { ...NO_FILTER, ...f }, NOW)).map((r) => r.subscription_id);
    expect(pass({ status: 'GRACE' })).toEqual(['b']);
    expect(pass({ status: 'SUSPENDED' })).toEqual(['c']);
    expect(pass({ source: 'MANUAL' })).toEqual([SUB_MERIDIAN, 'c', 'd']);
    expect(pass({ version: PV_TEAM_2 })).toEqual(['d']);
    expect(pass({ commitment: '30' })).toEqual(['c']);
    expect(pass({ commitment: '90' })).toEqual(['c']);
    expect(pass({ flagged: true })).toEqual(['b']);
    expect(pass({ product: 'ats' })).toEqual([]);
  });
});

describe('CCP-B3 Tenant › Commercial model (handoff §5.9)', () => {
  it('B3-M-8 provenance: provisioning, change request, migration, signup, revoked', () => {
    expect(provenanceText(entitlement())).toBe('Granted by provisioning · 15 Mar 2025');
    expect(provenanceText(entitlement({ granted_source: 'MANUAL', change_request_id: '0190b300-0000-7000-8000-0000000b3e99' }))).toBe('Granted by change request CR-0190B300 · 15 Mar 2025');
    expect(provenanceText(entitlement({ granted_source: 'MIGRATION' }))).toBe('Migrated — provenance: migration · 15 Mar 2025');
    expect(provenanceText(entitlement({ granted_source: 'SIGNUP' }))).toBe('Granted by signup · 15 Mar 2025');
    expect(provenanceText(entitlement({ state: 'REVOKED', revoked_at: '2026-10-02T00:00:00.000Z', revoke_change_request_id: '0190b300-0000-7000-8000-0000000b3e98' }))).toBe('Revoked 2 Oct 2026 · CR-0190B300 · was granted by provisioning');
    expect(provenanceText(entitlement({ state: 'NONE' }))).toBe('');
  });

  it('B3-M-9 the allowance bar: counts only, warn at 90% or more', () => {
    expect(allowanceBar(4410, 10000)).toEqual({ text: '4,410 of 10,000 envelopes', pct: 44, warn: false });
    expect(allowanceBar(96, 100)).toEqual({ text: '96 of 100 envelopes', pct: 96, warn: true });
    expect(allowanceBar(5, null).text).toBe('5 envelopes · unlimited');
  });

  it('B3-M-10 the release state line: none → needs a release; APPLYING → sent to Stripe, awaiting confirmation (C1 / C-23)', () => {
    expect(releaseState(heldFlag())).toBe('Needs a Commercial ops release request.');
    expect(releaseState(heldFlag({ conversion: { change_request_id: 'x', state: 'PENDING_APPROVAL', direction: 'TO_GOVERNED' } }))).toBe('Release request:');
    expect(releaseState(heldFlag({ conversion: { change_request_id: 'x', state: 'APPLYING', direction: 'TO_GOVERNED' } }))).toBe('Release sent to Stripe — awaiting confirmation:');
    // B5-R: APPLY_EXPIRED reaches a CONVERSION; an expired release needs a new request.
    const expired = heldFlag({ conversion: { change_request_id: 'x', state: 'APPLY_EXPIRED', direction: 'TO_GOVERNED' } });
    expect(releaseState(expired)).toBe('Release request apply expired; needs a new Commercial ops release request:');
    expect(needsRelease(expired)).toBe(true);
    expect(needsRelease(heldFlag({ conversion: { change_request_id: 'x', state: 'PENDING_APPROVAL', direction: 'TO_GOVERNED' } }))).toBe(false);
  });
});

describe('CCP-B3 actions — gating and domain reasons (handoff §5.9 "Actions")', () => {
  it('B3-A-1 commercial_ops on a governed MANUAL row: plan change, cancel, revoke enabled; support extension needs Support admin', () => {
    const a = byKey(ctx());
    expect(a['plan']).toMatchObject({ disabled: false, domain: '' });
    expect(a['cancel']).toMatchObject({ disabled: false, danger: true });
    expect(a['revoke']).toMatchObject({ disabled: false, danger: true });
    expect(a['grant']).toBeUndefined();
    expect(a['extension']).toMatchObject({ disabled: true, why: 'Needs the Support admin role.', domain: '' });
    expect(a['convert']).toBeUndefined();
  });

  it('B3-A-2 a role without the requester scope: every request disabled with the role reason, no domain reason', () => {
    const a = byKey(ctx({ canSubscription: false, canEntitlement: false }));
    for (const k of ['plan', 'cancel', 'revoke']) expect(a[k]).toMatchObject({ disabled: true, why: 'Needs the Commercial ops role.', domain: '' });
  });

  it('B3-A-3 a Stripe-owned row is read-only: plan change and cancel carry the Stripe reasons; only the governed conversion is offered', () => {
    const a = byKey(ctx({ product: product({ subscription: STRIPE_ROW() }) }));
    expect(a['plan']).toMatchObject({ disabled: true, domain: 'Managed in Stripe. The tenant changes plans in Stripe checkout.' });
    expect(a['cancel']).toMatchObject({ disabled: true, domain: 'Managed in Stripe. Cancellation happens in Stripe.' });
    expect(a['convert']).toMatchObject({ label: 'Request conversion to MANUAL…', disabled: false, domain: '' });
  });

  it('B3-A-4 DR-C2-1: a self-service row inside its commitment term cannot be converted (FINANCIAL_TREATMENT_UNDEFINED)', () => {
    const s = STRIPE_ROW({ commitment_end: '2027-02-10T00:00:00.000Z' });
    expect(insideCommitment(s, NOW)).toBe(true);
    const a = byKey(ctx({ product: product({ subscription: s }) }));
    expect(a['convert']!.disabled).toBe(true);
    expect(a['convert']!.domain).toContain('FINANCIAL_TREATMENT_UNDEFINED');
    expect(a['convert']!.domain).toContain('10 Feb 2027');
  });

  it('B3-A-5 contract-priced plan, no subscription, no catalog, open request (Q14)', () => {
    expect(byKey(ctx({ product: product({ subscription: facts({ plan: { id: 'e', key: 'aramo-sign-enterprise-v1', name: 'Enterprise', sales_model: 'CONTACT_SALES' } }) }) }))['plan']!.domain).toBe('Enterprise is contract-priced; record a contract amendment instead.');
    const none = byKey(ctx({ product: product({ subscription: null, entitlement: entitlement({ state: 'NONE' }) }) }));
    expect(none['plan']!.domain).toBe('No open subscription.');
    expect(none['cancel']!.domain).toBe('No open subscription.');
    expect(none['grant']).toMatchObject({ disabled: false });
    const ats = byKey(ctx({ product: product({ product_key: 'ats', registered: false, subscription: null }) }));
    expect(ats['plan']!.domain).toBe('No commercial plans yet.');
    expect(ats['revoke']!.domain).toBe('No governed request covers this product yet.');
    const blocked = byKey(ctx({ product: product({ open_request: openRequest() }) }));
    expect(blocked['plan']).toMatchObject({ disabled: true, domain: '' });
    expect(blocked['plan']!.why).toMatch(/^Open request CR-0190B300\. Other requests on this product wait until it closes\.$/);
  });
});

describe('CCP-B3 the action-to-change-request trace (payloads; PBD §5.3 B3 acceptance)', () => {
  const team = planChoices(CATALOG, 'sign').find((c) => c.plan.name === 'Team')!;
  it('B3-P-1 plan choices: newest PUBLISHED version of each list-priced plan (contract-priced excluded); price label', () => {
    expect(planChoices(CATALOG, 'sign').map((c) => `${c.plan.name} v${c.version.version_number}`)).toEqual(['Team v2', 'Scale v1']);
    expect(priceLabel(team.version)).toBe('$59 / month');
  });
  it('B3-P-2 every dialog maps to exactly one A3 / C2 payload', () => {
    const p = product();
    expect(payloadOf('plan', { product: p, flag: null, next: team, evidence: 'E' })).toEqual({ subscription_id: SUB_MERIDIAN, plan_key: 'aramo-sign-team-v1', plan_version_id: PV_TEAM_2 });
    expect(payloadOf('cancel', { product: p, flag: null, next: null, evidence: 'MSA §4' })).toEqual({ subscription_id: SUB_MERIDIAN, contract_end: { contract_id: CONTRACT, documents: [], evidence_ref: 'MSA §4' } });
    expect(payloadOf('cancel', { product: product({ subscription: facts({ contract: null }) }), flag: null, next: null, evidence: 'E' })).toEqual({ subscription_id: SUB_MERIDIAN });
    expect(payloadOf('grant', { product: p, flag: null, next: null, evidence: 'E' })).toEqual({ capabilities: ['core', 'sign'] });
    expect(payloadOf('revoke', { product: p, flag: null, next: null, evidence: 'E' })).toEqual({ capabilities: ['sign'] });
    expect(payloadOf('recon', { product: p, flag: heldFlag(), next: null, evidence: 'E' })).toEqual({ direction: 'TO_GOVERNED', held_subscription_ref: 'sub_held_1', governed_subscription_id: SUB_MERIDIAN });
    const s = product({ subscription: STRIPE_ROW() });
    expect(payloadOf('convert', { product: s, flag: null, next: team, evidence: 'E' })).toEqual({ direction: 'TO_GOVERNED', subscription_id: STRIPE_ROW().subscription_id, plan_key: 'aramo-sign-team-v1', plan_version_id: PV_TEAM_2 });
    expect(payloadOf('plan', { product: product({ subscription: null }), flag: null, next: team, evidence: 'E' })).toBeNull();
  });
  it('B3-P-3 the dialogs’ before → after rows (cancel keeps the entitlement: A6 TD-A6-8)', () => {
    expect(diffRows('cancel', { product: product(), current: null, next: null, currentPlanName: 'Scale' }).map((r) => [r.field, r.before, r.after])).toEqual([
      ['Subscription', 'Active', 'Ended'],
      ['Aramo Sign entitlement', 'Active', 'Active (unchanged)'],
    ]);
    const plan = diffRows('plan', { product: product(), current: planChoices(CATALOG, 'sign')[1]!.version, next: team, currentPlanName: 'Scale' });
    expect(plan.map((r) => [r.field, r.before, r.after, r.changed])).toEqual([
      ['Plan', 'Sign Scale', 'Sign Team', true],
      ['Plan version', 'v1', 'v2', true],
      ['Price', '$299 / month', '$59 / month', true],
      ['Discount', 'None', 'None', false],
      ['Allowance', '10,000 envelopes', '750 envelopes', true],
    ]);
  });
});

describe('CCP-B3 refusal lines', () => {
  it('B3-R-1 DR-C2-1: the conversion apply refused FINANCIAL_TREATMENT_UNDEFINED is named and explained', () => {
    const err = new ApiError(409, 'conversion failed', 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', { reason: 'apply_failed', failure: 'FINANCIAL_TREATMENT_UNDEFINED', attempt: 1, request_state: 'APPLY_FAILED' });
    const line = refusalLine(err);
    expect(line).toMatch(/^Apply failed: FINANCIAL_TREATMENT_UNDEFINED\. /);
    expect(line).toContain('inside its commitment term');
    expect(line).toContain('Nothing was sent to Stripe');
    expect(line).toContain('409 COMMERCIAL_CHANGE_REQUEST_CONFLICT · apply_failed');
  });
  it('B3-R-2 not the requester, apply refused (NC-5), open request, plain 403', () => {
    expect(refusalLine(new ApiError(403, 'x', 'INSUFFICIENT_PERMISSIONS', { reason: 'not_requester' }))).toMatch(/^Refused: only the person who made the request can apply it\./);
    expect(refusalLine(new ApiError(409, 'x', 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', { reason: 'apply_refused', refusal: 'APPROVER_NO_LONGER_ELIGIBLE', explanation: 'An approver lost eligibility.' }))).toBe('Refused: APPROVER_NO_LONGER_ELIGIBLE. An approver lost eligibility. (409 COMMERCIAL_CHANGE_REQUEST_CONFLICT · apply_refused)');
    expect(refusalLine(new ApiError(409, 'x', 'COMMERCIAL_CHANGE_REQUEST_CONFLICT', { reason: 'open_request_exists' }))).toMatch(/another request on this product is open/);
    expect(refusalLine(new ApiError(403, 'x', 'INSUFFICIENT_PERMISSIONS', {}))).toMatch(/permission/);
    expect(crRef('0190b300-0000-7000-8000-0000000b3e01')).toBe('CR-0190B300');
  });
});
