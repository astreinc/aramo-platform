// M-A14 R-3 — field suggestions: defensive parsing, WIRE → EDITOR boxes, [] on failure,
// and the device preference (default on).
import { workspaceWith } from '../../inbox/__tests__/fixtures';
import { memoryKv } from '../../../testing/fakes';
import {
  AUTO_SUGGEST_KEY,
  autoSuggestPref,
  fetchFieldSuggestions,
  parseSuggestions,
  suggestFields,
  suggestionsToFields,
} from '../fieldSuggestions';
import { SELF_KEY } from '../selfSignModel';

const PAGE = { width: 612, height: 792 };

describe('field suggestions (R-3)', () => {
  it('keeps only SIGNATURE / SIGN_DATE boxes with a 1-based page and a positive size, at most 6', () => {
    const good = { type: 'SIGNATURE', page: 1, x: 72, y: 100, width: 200, height: 46 };
    expect(
      parseSuggestions({
        suggestions: [
          good,
          { type: 'TEXT', page: 1, x: 1, y: 1, width: 1, height: 1 },
          { type: 'SIGN_DATE', page: 0, x: 1, y: 1, width: 1, height: 1 },
          { type: 'SIGN_DATE', page: 1, x: 1, y: 1, width: 0, height: 1 },
          { type: 'SIGN_DATE', page: 1.5, x: 1, y: 1, width: 1, height: 1 },
          null,
        ],
      }),
    ).toEqual([good]);
    expect(parseSuggestions({ suggestions: Array.from({ length: 9 }, () => good) })).toHaveLength(6);
    expect(parseSuggestions(null)).toEqual([]);
    expect(parseSuggestions({ suggestions: 'x' })).toEqual([]);
  });

  it('converts the placement (bottom-left) frame to editor fields for the caller, 0-based pages', () => {
    let n = 0;
    const fields = suggestionsToFields(
      { key: 'd1', pages: [PAGE, PAGE] },
      [
        { type: 'SIGNATURE', page: 2, x: 72, y: 100, width: 200, height: 46 },
        { type: 'SIGN_DATE', page: 3, x: 72, y: 100, width: 124, height: 24 },
      ],
      () => `k${++n}`,
    );
    expect(fields).toEqual([
      { key: 'k1', docKey: 'd1', page: 1, recipientKey: SELF_KEY, type: 'SIGNATURE', required: true, x: 72, y: 792 - 100 - 46, width: 200, height: 46 },
    ]);
  });

  it('GETs the suggestions route per uploaded document; any failure is no suggestions', async () => {
    const ok = workspaceWith(() => ({ status: 200, body: { suggestions: [{ type: 'SIGN_DATE', page: 1, x: 1, y: 2, width: 100, height: 20 }] } }));
    expect(await fetchFieldSuggestions(ok.workspace, 'env-1', 'doc-1')).toHaveLength(1);
    expect(ok.net.calls[0]?.url).toBe('https://sign.aramo.ai/v1/sign/sender/envelopes/env-1/documents/doc-1/field-suggestions');
    expect(ok.net.calls[0]?.method).toBe('GET');

    const down = workspaceWith(() => ({ status: 500, body: { reason: 'x' } }));
    expect(await fetchFieldSuggestions(down.workspace, 'env-1', 'doc-1')).toEqual([]);

    const fields = await suggestFields(ok.workspace, 'env-1', [
      { key: 'a', title: 'A', filename: 'A.pdf', base64: null, pages: [PAGE], serverId: 'doc-1' },
      { key: 'b', title: 'B', filename: 'B.pdf', base64: null, pages: [PAGE], serverId: null },
    ]);
    expect(fields.map((f) => [f.docKey, f.type])).toEqual([['a', 'SIGN_DATE']]);
  });

  it('the "Auto suggest fields" choice is stored on this device, default on', async () => {
    const kv = memoryKv();
    expect(await autoSuggestPref.get(kv)).toBe(true);
    await autoSuggestPref.set(kv, false);
    expect(kv.items.get(AUTO_SUGGEST_KEY)).toBe('0');
    expect(await autoSuggestPref.get(kv)).toBe(false);
  });
});
