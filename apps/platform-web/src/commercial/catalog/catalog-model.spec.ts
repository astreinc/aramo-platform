import { describe, expect, it } from 'vitest';

import {
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
  storageGb,
  versionActions,
} from './catalog-model';
import { ENTERPRISE, TEAM, TERMS } from './catalog-test-data';

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

  it('a DRAFT is editable only by a drafter; seats (no backing term) never; a contract price never', () => {
    const ed = editorOf(TEAM, draft, true);
    expect(ed.lockText).toBeNull();
    expect(ed.fields.map((f) => [f.key, f.readOnly])).toEqual([
      ['price', false],
      ['envelopes', false],
      ['seats', true],
      ['storage', false],
    ]);
    expect(ed.fields.map((f) => f.value)).toEqual(['69', '1000', '', '50']);
    expect(editorOf(TEAM, draft, false).fields.every((f) => f.readOnly)).toBe(true);
    expect(editorOf(TEAM, draft, false).lockText).toBe(LOCK_TEXT_VIEW_ONLY);
    const entDraft = { ...ENTERPRISE.versions[0]!, status: 'DRAFT' as const };
    expect(editorOf(ENTERPRISE, entDraft, true).fields.filter((f) => !f.readOnly)).toEqual([]);
    expect(editorOf(TEAM, draft, true).locks).toEqual([
      { label: 'Currency', value: 'USD' },
      { label: 'Billing interval', value: 'Monthly' },
    ]);
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
      ['Seats', '—', '—', false],
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
