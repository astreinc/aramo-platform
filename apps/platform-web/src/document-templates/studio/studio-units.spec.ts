import { describe, expect, it } from 'vitest';
import type { StudioBlock } from '@aramo/document-templates-web';

import { blockDiff, diffStats, lcs, tokens, wordDiff } from './diff';
import { appendVariable, deleteBlock, duplicateBlock, insertBlocks, moveBlock, removeVariableEverywhere, setBlockKind, shiftBlock } from './doc-ops';
import { estimateBlockHeight, paginate, zoomIn, zoomOut } from './pagination';
import { checksLine, deriveReadiness, isPreviewed, readinessLabel, type ReadinessInput } from './readiness';
import { effectiveLine, noticeDaysValid, publishConsequence } from './studio-dialogs';
import { buildCatalog, chipInfo } from './variables';

// PLATFORM-UX-1 F-9 — the Studio's pure logic: the diff algorithm (handoff §10.7), readiness
// derivation (§10.6), block operations (§10.4), page estimate, withdraw and publish copy.

const b = (id: string, kind: StudioBlock['kind'], value: string): StudioBlock => ({ id, kind, value });

describe('diff — LCS block diff + word diff (Template Studio.dc.html)', () => {
  it('lcs aligns equal items', () => {
    expect(lcs(['a', 'b', 'c'], ['a', 'c'], (x, y) => x === y)).toEqual([
      ['=', 0, 0],
      ['-', 1, null],
      ['=', 2, 1],
    ]);
  });

  it('pairs adjacent removed + added blocks as changed and word-diffs them', () => {
    const rows = blockDiff(
      [
        { kind: 'h2', text: 'Offer' },
        { kind: 'p', text: 'Salary is {{offer.base_salary}} per annum.' },
        { kind: 'p', text: 'Old clause.' },
      ],
      [
        { kind: 'h2', text: 'Offer' },
        { kind: 'p', text: 'Salary is {{offer.base_salary}} paid monthly.' },
        { kind: 'p', text: 'New one.' },
        { kind: 'p', text: 'Extra.' },
      ],
    );
    expect(rows.map((r) => r.kind)).toEqual(['same', 'chg', 'chg', 'add']);
    const chg = rows[1];
    expect(chg?.L.filter((s) => s.kind === 'del').map((s) => s.t)).toEqual(['per', 'annum.']);
    expect(chg?.R.filter((s) => s.kind === 'add').map((s) => s.t)).toEqual(['paid', 'monthly.']);
    expect(chg?.L.find((s) => s.t === '{{offer.base_salary}}')?.isVar).toBe(true);
    expect(diffStats(rows)).toEqual({ added: 1, changed: 2, removed: 0, unchanged: 1 });
  });

  it('a surplus of removed blocks stays removed', () => {
    const rows = blockDiff([{ kind: 'p', text: 'a' }, { kind: 'p', text: 'b' }], [{ kind: 'p', text: 'c' }]);
    expect(rows.map((r) => r.kind)).toEqual(['chg', 'del']);
  });

  it('identical content is all unchanged', () => {
    const A = [{ kind: 'p', text: 'x y' }];
    expect(blockDiff(A, A).every((r) => r.kind === 'same')).toBe(true);
  });

  it('tokens keep whitespace; word diff marks only the changed words', () => {
    expect(tokens('a  b')).toEqual(['a', '  ', 'b']);
    const { L, R } = wordDiff('one two', 'one three');
    expect(L.map((s) => s.kind)).toEqual(['same', 'same', 'del']);
    expect(R.map((s) => s.kind)).toEqual(['same', 'same', 'add']);
  });
});

describe('readiness — derived, never stored (handoff §10.6)', () => {
  const catalog = buildCatalog(
    [
      { id: '1', key: 'talent.first_name', label: 'First name', group_label: 'Talent', data_type: 'TEXT', products: [], ats_binding_key: 'talent.first_name', sample_value: 'Amina', active: true, created_at: '', updated_at: '' },
      { id: '2', key: 'offer.hours', label: 'Hours', group_label: 'Offer', data_type: 'NUMBER', products: [], ats_binding_key: null, sample_value: '40', active: false, created_at: '', updated_at: '' },
    ],
    [{ key: 'talent.first_name', label: 'First name', group: 'Talent' }],
  );
  const base: ReadinessInput = {
    title: 'Offer',
    blocks: [b('1', 'p', 'Dear <span data-field="talent.first_name"></span>')],
    chipState: (k) => chipInfo(catalog, k).state,
    dirty: false,
    savedRev: 2,
    previewedRev: 2,
    withdrawal: 'NONE',
  };

  it('is ready when every required check passes', () => {
    const r = deriveReadiness(base);
    expect(r.ready).toBe(true);
    expect(r.items).toHaveLength(6);
    expect(readinessLabel(r, true)).toBe('Ready to publish');
    expect(readinessLabel(r, false)).toBe('Ready');
    expect(checksLine(r)).toBe('6 of 6 checks pass');
  });

  it('previewed = !dirty && previewedRev === savedRev', () => {
    expect(isPreviewed(false, 3, 3)).toBe(true);
    expect(isPreviewed(true, 3, 3)).toBe(false);
    expect(isPreviewed(false, 4, 3)).toBe(false);
    expect(isPreviewed(false, 0, null)).toBe(false);
    const r = deriveReadiness({ ...base, savedRev: 3 });
    expect(r.ready).toBe(false);
    expect(r.items.find((i) => i.id === 'previewed')?.ok).toBe(false);
  });

  it('dirty fails both "Draft saved" and "Previewed after the last save"', () => {
    const r = deriveReadiness({ ...base, dirty: true });
    expect(r.fails).toBe(2);
    expect(readinessLabel(r, true)).toBe('2 issues before publishing');
  });

  it('an unknown variable is a required failure with the remove fix; an inactive one only warns', () => {
    const r = deriveReadiness({
      ...base,
      blocks: [b('1', 'p', '<span data-field="x.y"></span> <span data-field="offer.hours"></span>')],
    });
    const unknown = r.items.find((i) => i.id === 'unknown:x.y');
    const inactive = r.items.find((i) => i.id === 'inactive:offer.hours');
    expect(unknown?.severity).toBe('fail');
    expect(unknown?.label).toBe('Unknown variable {{x.y}}');
    expect(unknown?.fixKey).toBe('x.y');
    expect(inactive?.severity).toBe('warn');
    expect(r.fails).toBe(1);
    expect(r.warns).toBe(1);
    expect(checksLine(r)).toBe('6 of 8 checks pass · 1 warning');
    expect(r.ready).toBe(false);
  });

  it('title, content and withdrawal checks', () => {
    expect(deriveReadiness({ ...base, title: '  ' }).items.find((i) => i.id === 'title')?.ok).toBe(false);
    expect(deriveReadiness({ ...base, blocks: [b('1', 'p', '')] }).items.find((i) => i.id === 'content')?.ok).toBe(false);
    expect(deriveReadiness({ ...base, withdrawal: 'IN_EFFECT' }).ready).toBe(false);
    expect(deriveReadiness({ ...base, withdrawal: 'PENDING' }).ready).toBe(true);
  });

  it('counts variable usage with repeats', () => {
    const r = deriveReadiness({ ...base, blocks: [b('1', 'p', '<span data-field="talent.first_name"></span><span data-field="talent.first_name"></span>')] });
    expect(r.used.get('talent.first_name')).toBe(2);
  });
});

describe('variables — chip states', () => {
  const catalog = buildCatalog(
    [
      { id: '1', key: 'a.b', label: 'A', group_label: 'G', data_type: 'MULTILINE_TEXT', products: [], ats_binding_key: 'a.b', sample_value: 's', active: true, created_at: '', updated_at: '' },
      { id: '2', key: 'c.d', label: 'C', group_label: 'G', data_type: 'TEXT', products: [], ats_binding_key: null, sample_value: null, active: true, created_at: '', updated_at: '' },
    ],
    [{ key: 'a.b', label: 'A', group: 'G' }],
  );
  it('known / unknown-for-this-type / unknown', () => {
    expect(chipInfo(catalog, 'a.b')).toEqual({ state: 'known', title: 'A · e.g. s' });
    expect(chipInfo(catalog, 'c.d').state).toBe('unknown');
    expect(chipInfo(catalog, 'z.z')).toEqual({ state: 'unknown', title: 'Unknown variable — not in Template variables' });
    expect(catalog.list.find((v) => v.key === 'a.b')?.type).toBe('multiline text');
    expect(catalog.list.find((v) => v.key === 'c.d')?.insertable).toBe(false);
  });
});

describe('doc-ops — block operations', () => {
  const list = [b('1', 'p', 'one'), b('2', 'h2', 'two'), b('3', 'p', 'three')];
  it('move before / after / end, and a no-op onto itself', () => {
    expect(moveBlock(list, '1', '3', 'after').map((x) => x.id)).toEqual(['2', '3', '1']);
    expect(moveBlock(list, '3', '1', 'before').map((x) => x.id)).toEqual(['3', '1', '2']);
    expect(moveBlock(list, '1', null, 'after').map((x) => x.id)).toEqual(['2', '3', '1']);
    expect(moveBlock(list, '2', '2', 'after').map((x) => x.id)).toEqual(['1', '2', '3']);
  });
  it('⌥↑ / ⌥↓ swap with the neighbour, clamped at the ends', () => {
    expect(shiftBlock(list, '2', -1).map((x) => x.id)).toEqual(['2', '1', '3']);
    expect(shiftBlock(list, '3', 1).map((x) => x.id)).toEqual(['1', '2', '3']);
  });
  it('insert, duplicate, delete, turn into', () => {
    expect(insertBlocks(list, [b('9', 'p', 'x')], '1').map((x) => x.id)).toEqual(['1', '9', '2', '3']);
    expect(insertBlocks(list, [b('9', 'p', 'x')], '1', true).map((x) => x.id)).toEqual(['9', '1', '2', '3']);
    expect(insertBlocks(list, [b('9', 'p', 'x')], null).map((x) => x.id)).toEqual(['1', '2', '3', '9']);
    const dup = duplicateBlock(list, '2');
    expect(dup).toHaveLength(4);
    expect(dup[2]?.value).toBe('two');
    expect(deleteBlock(list, '2').map((x) => x.id)).toEqual(['1', '3']);
    expect(setBlockKind([b('1', 'p', 'A<br>B')], '1', 'ul')[0]).toEqual({ id: '1', kind: 'ul', value: '<li>A</li><li>B</li>' });
  });
  it('removes a variable everywhere and appends one to a block', () => {
    const vs = [b('1', 'p', 'a <span data-field="k.x"></span>'), b('2', 'ul', '<li><span data-field="k.x"></span> b</li>')];
    expect(removeVariableEverywhere(vs, 'k.x').map((x) => x.value)).toEqual(['a ', '<li> b</li>']);
    expect(appendVariable(list, '1', 'k.x')[0]?.value).toBe('one <span data-field="k.x"></span>');
  });
});

describe('pagination — client-estimated A4 breaks', () => {
  it('fills page 1 under the title, then breaks', () => {
    expect(estimateBlockHeight('x'.repeat(88))).toBe(52);
    expect(paginate([])).toEqual([[]]);
    const texts = Array.from({ length: 20 }, () => 'x'.repeat(170)); // 76px each
    const pages = paginate(texts);
    expect(pages.length).toBe(2);
    expect(pages[0]).toHaveLength(10); // 70 + 10 × 76 = 830 ≤ 860
    expect(pages.flat()).toHaveLength(20);
  });
  it('zoom 60–150 in steps of 10', () => {
    expect(zoomIn(150)).toBe(150);
    expect(zoomIn(100)).toBe(110);
    expect(zoomOut(60)).toBe(60);
    expect(zoomOut(100)).toBe(90);
  });
});

describe('withdraw + publish copy', () => {
  it('notice period 0–365 whole days', () => {
    expect(noticeDaysValid('7')).toBe(true);
    expect(noticeDaysValid('0')).toBe(true);
    expect(noticeDaysValid('365')).toBe(true);
    expect(noticeDaysValid('366')).toBe(false);
    expect(noticeDaysValid('-1')).toBe(false);
    expect(noticeDaysValid('1.5')).toBe(false);
    expect(noticeDaysValid('')).toBe(false);
  });
  it('live effective date line', () => {
    const now = new Date('2026-10-24T15:00:00Z');
    expect(effectiveLine('7', now)).toBe('Takes effect 31 Oct 2026');
    expect(effectiveLine('0', now)).toBe('Takes effect 24 Oct 2026 (immediately)');
    expect(effectiveLine('400', now)).toBe('Enter 0–365 days.');
  });
  it('publish consequence names the replaced version only when one exists', () => {
    expect(publishConsequence(4, 3)).toBe(
      'v4 becomes the platform default for every tenant that uses this template. Documents already sent are not changed. v3 is marked Replaced and stays viewable.',
    );
    expect(publishConsequence(1, null)).toBe('v1 becomes the platform default for every tenant that uses this template. Documents already sent are not changed.');
  });
});
