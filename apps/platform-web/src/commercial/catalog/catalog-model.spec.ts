import { describe, expect, it } from 'vitest';

import {
  NEEDS_CATALOG_MANAGER,
  NOT_SOLD,
  parseUnitPriceInput,
  unitPriceFields,
  unitPriceText,
  LOCK_TEXT_PUBLISHED,
  LOCK_TEXT_VIEW_ONLY,
  draftDiff,
  editorOf,
  formatDay,
  grandfatheringLine,
  money,
  parseFieldInput,
  pinnedLine,
  planRow,
  PRICE_UNIT_CONTRACT_TITLE,
  pricePerSeatOf,
  storageGb,
  versionActions,
} from './catalog-model';
import { ENTERPRISE, TEAM, TERMS, v } from './catalog-test-data';

// CCP-B2 — the pure Catalog view model (handoff §5.4).

const [draft, published, retired] = TEAM.versions as [(typeof TEAM.versions)[0], (typeof TEAM.versions)[0], (typeof TEAM.versions)[0]];

describe('CCP-B2 catalog model', () => {
  it('formats money, days and binary storage like the design', () => {
    expect(money(5900)).toBe('$59');
    expect(money(1999)).toBe('$19.99');
    expect(money(1_000_000)).toBe('$10,000');
    expect(formatDay('2026-01-15T00:00:00.000Z')).toBe('15 Jan 2026');
    expect(formatDay(null)).toBe('—');
    expect(storageGb(10 * 1024 ** 3)).toBe(10);
    expect(storageGb(15 * 1024 ** 2)).toBe(0.015);
  });

  it('plan rows: latest published price, every version state, pin counts on non-draft versions', () => {
    expect(planRow(TEAM)).toEqual({ title: 'Sign Team', price: '$59 / mo', versions: 'v1 retired · v2 published · v3 draft', counts: '1 on v1, 1 on v2' });
    expect(planRow(ENTERPRISE).price).toBe('Contract only');
    expect(grandfatheringLine(TEAM)).toBe('1 tenant(s) on v1 · 1 tenant(s) on v2. Subscriptions keep their pinned version.');
  });

  it('PUBLISHED and RETIRED versions are read-only for every role: no editable field, the immutability lock line', () => {
    for (const v of [published, retired]) {
      for (const canDraft of [true, false]) {
        const ed = editorOf(TEAM, v, canDraft);
        expect(ed.fields.every((f) => f.readOnly), `${v.status} canDraft=${String(canDraft)}`).toBe(true);
        expect(ed.lockText).toBe(LOCK_TEXT_PUBLISHED);
      }
    }
  });

  it('a DRAFT is editable only by a drafter; a contract price never', () => {
    const ed = editorOf(TEAM, draft, true);
    expect(ed.lockText).toBeNull();
    expect(ed.fields.map((f) => [f.key, f.readOnly])).toEqual([
      ['price', false],
      ['envelopes', false],
      ['storage', false],
    ]);
    expect(ed.fields.map((f) => f.value)).toEqual(['69', '1000', '50']);
    expect(editorOf(TEAM, draft, false).fields.every((f) => f.readOnly)).toBe(true);
    expect(editorOf(TEAM, draft, false).lockText).toBe(LOCK_TEXT_VIEW_ONLY);
    const entDraft = { ...ENTERPRISE.versions[0]!, status: 'DRAFT' as const };
    expect(editorOf(ENTERPRISE, entDraft, true).fields.filter((f) => !f.readOnly)).toEqual([]);
    expect(editorOf(TEAM, draft, true).locks).toEqual([
      { label: 'Currency', value: 'USD' },
      { label: 'Billing interval', value: 'Monthly' },
    ]);
  });

  it('V12-AM10 Request publish… stays disabled while the publish request is APPROVED (awaiting apply) or APPLY_FAILED', () => {
    for (const state of ['APPROVED', 'APPLY_FAILED', 'PENDING_APPROVAL']) {
      const open = { ...draft, open_requests: [{ id: 'cr', action_type: 'PLAN_VERSION_PUBLISH' as const, state, expires_at: null }] };
      expect(versionActions(TEAM, open, true).find((a) => a.kind === 'publish')).toMatchObject({ disabled: true, why: 'A publish request is already open.' });
    }
  });

  it('actions: a DRAFT offers only Request publish…; a published version offers a new draft (when none exists) and Retire this version… — never an edit', () => {
    expect(versionActions(TEAM, draft, true).map((a) => [a.label, a.disabled])).toEqual([['Request publish…', false]]);
    expect(versionActions(TEAM, published, true).map((a) => a.label)).toEqual(['Retire this version…']);
    const noDraft = { ...TEAM, versions: [published, retired] };
    expect(versionActions(noDraft, published, true).map((a) => a.label)).toEqual(['Create new draft from v2', 'Retire this version…']);
    expect(versionActions(noDraft, retired, true).map((a) => a.label)).toEqual(['Create new draft from v1']);
    expect(versionActions(ENTERPRISE, ENTERPRISE.versions[0]!, true).map((a) => a.label)).toEqual(['Create new draft from v1']);
    for (const a of [...versionActions(TEAM, draft, true), ...versionActions(noDraft, published, true)]) expect(a.label).not.toMatch(/edit|publish now|apply/i);
    // Every action is disabled with the reason for a role without platform:catalog:draft.
    for (const a of versionActions(noDraft, published, false)) expect([a.disabled, a.why]).toEqual([true, 'Needs the Catalog manager role.']);
    // An open publish request disables a second one.
    const pending = { ...draft, open_requests: [{ id: 'cr-1', action_type: 'PLAN_VERSION_PUBLISH' as const, state: 'PENDING_APPROVAL', expires_at: null }] };
    expect(versionActions(TEAM, pending, true)[0]).toMatchObject({ disabled: true, why: 'A publish request is already open.' });
  });

  it('draft diff marks the changed terms; pinned line; field parsing', () => {
    const rows = draftDiff(TERMS, draft.terms, 'editor');
    expect(rows.map((r) => [r.field, r.before, r.after, r.changed])).toEqual([
      ['Price', '$59', '$69', true],
      ['Envelopes', '750', '1,000', true],
      ['Pricing unit', 'Per organization', 'Per organization', false],
      ['Storage', '50 GB', '50 GB', false],
    ]);
    expect(pinnedLine(draft, null)).toBe('None — drafts take no subscriptions.');
    expect(pinnedLine(retired, ['Quarry Lane Legal'])).toBe('Quarry Lane Legal (grandfathered; no new subscriptions)');
    expect(pinnedLine(published, [])).toBe('No tenants');
    expect(parseFieldInput('price', '24.5')).toEqual({ ok: true, value: 2450 });
    expect(parseFieldInput('price', '')).toEqual({ ok: false });
    expect(parseFieldInput('envelopes', '')).toEqual({ ok: true, value: null });
    expect(parseFieldInput('envelopes', '1.5')).toEqual({ ok: false });
    expect(parseFieldInput('storage', '10')).toEqual({ ok: true, value: 10 * 1024 ** 3 });
    expect(parseFieldInput('storage', '-1')).toEqual({ ok: false });
  });
});

// Sign Feature Parity Amendments A3 (D1) / A4 (D2) — the add-on unit-price model of the editor.
describe('A4 D2 add-on unit prices', () => {
  const UNITS = [
    { unit_key: 'sign.sms_message', name: 'SMS delivery', quantity_label: 'message' },
    { unit_key: 'sign.id_verification', name: 'ID verification', quantity_label: 'verification' },
  ];
  const priced = { ...TERMS, unit_prices: [{ unit_key: 'sign.sms_message', unit_price_minor: 5 }] };

  it('A4-U-1 parses dollars to cents (at most 2 decimals, at most $100,000); empty = not sold', () => {
    expect(parseUnitPriceInput('0.05')).toEqual({ ok: true, value: 5 });
    expect(parseUnitPriceInput('1.5')).toEqual({ ok: true, value: 150 });
    expect(parseUnitPriceInput(' 2 ')).toEqual({ ok: true, value: 200 });
    expect(parseUnitPriceInput('')).toEqual({ ok: true, value: null });
    expect(parseUnitPriceInput('100000')).toEqual({ ok: true, value: 10_000_000 });
    for (const bad of ['-1', '0.055', 'abc', '1e3', '100000.01', '$1']) expect(parseUnitPriceInput(bad), bad).toEqual({ ok: false });
  });

  it('A4-U-2 the fields are editable only on a DRAFT for the catalog manager; a published version is read-only with the immutability reason', () => {
    const draft = v({ id: 'd', version_number: 3, status: 'DRAFT', terms: priced });
    const pub = v({ id: 'p', version_number: 2, status: 'PUBLISHED', terms: priced });
    expect(unitPriceFields(UNITS, draft, true)).toEqual([
      { unit_key: 'sign.sms_message', label: 'SMS delivery', per: 'per message', value: '0.05', placeholder: NOT_SOLD, editable: true, readOnly: false, title: undefined },
      { unit_key: 'sign.id_verification', label: 'ID verification', per: 'per verification', value: '', placeholder: NOT_SOLD, editable: true, readOnly: false, title: undefined },
    ]);
    expect(unitPriceFields(UNITS, draft, false).every((f) => f.readOnly && f.title === NEEDS_CATALOG_MANAGER)).toBe(true);
    expect(unitPriceFields(UNITS, pub, true).every((f) => f.readOnly && f.title === LOCK_TEXT_PUBLISHED)).toBe(true);
    expect(unitPriceFields(UNITS, draft, true, { 'sign.sms_message': '0.07' })[0]?.value).toBe('0.07');
  });

  it('A4-U-3 the draft diff lists every add-on priced on either side (Finance and the Owner see a price change)', () => {
    const rows = draftDiff(TERMS, priced, 'dialog', UNITS);
    expect(rows.slice(4)).toEqual([{ field: 'Add-on · SMS delivery', before: NOT_SOLD, after: '$0.05', changed: true }]);
    expect(draftDiff(TERMS, TERMS, 'dialog', UNITS)).toHaveLength(4);
    expect(unitPriceText(150)).toBe('$1.50');
  });
});

// Sign Business per-seat directive §3.4 — the "Priced per seat" toggle and the "Pricing unit" diff row.
describe('per-seat pricing unit', () => {
  const [draft, published] = TEAM.versions as [(typeof TEAM.versions)[0], (typeof TEAM.versions)[0]];
  const seatTerms = { ...TERMS, price_unit: 'SEAT' as const };

  it('PS-U-1 editable only on a DRAFT of a BUSINESS self-service plan for a catalog manager', () => {
    expect(pricePerSeatOf(TEAM, draft, true)).toEqual({ checked: false, readOnly: false, editable: true, title: undefined });
    expect(pricePerSeatOf(TEAM, { ...draft, terms: seatTerms }, true)?.checked).toBe(true);
    expect(pricePerSeatOf(TEAM, draft, false)).toMatchObject({ readOnly: true, title: NEEDS_CATALOG_MANAGER });
    expect(pricePerSeatOf(TEAM, published, true)).toMatchObject({ readOnly: true, title: LOCK_TEXT_PUBLISHED });
    const entDraft = { ...ENTERPRISE.versions[0]!, status: 'DRAFT' as const };
    expect(pricePerSeatOf(ENTERPRISE, entDraft, true)).toMatchObject({ readOnly: true, title: PRICE_UNIT_CONTRACT_TITLE });
  });

  it('PS-U-2 hidden for a PERSONAL plan and when the plan kind is unknown', () => {
    expect(pricePerSeatOf({ ...TEAM, tenant_kind: 'PERSONAL' }, draft, true)).toBeNull();
    const noKind = { ...TEAM };
    delete noKind.tenant_kind;
    expect(pricePerSeatOf(noKind, draft, true)).toBeNull();
  });

  it('PS-U-3 the diff row reads Per organization / Per seat and is left out when the unit does not apply', () => {
    expect(draftDiff(TERMS, seatTerms, 'editor').find((r) => r.field === 'Pricing unit')).toEqual({ field: 'Pricing unit', before: 'Per organization', after: 'Per seat', changed: true });
    expect(draftDiff(TERMS, TERMS, 'editor', [], { pricingUnit: false }).map((r) => r.field)).toEqual(['Price', 'Envelopes', 'Storage']);
  });
});
