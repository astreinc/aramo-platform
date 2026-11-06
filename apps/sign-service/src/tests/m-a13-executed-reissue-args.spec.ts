import { describe, expect, it } from 'vitest';

import { parseReissueArgs } from '../ops/executed-document-reissue.args.js';

// M-A13 R-1b — the reissue command is read-only (inventory) or a dry run unless --apply.
const T = '11111111-1111-4111-8111-111111111111';
const E = '22222222-2222-4222-8222-222222222222';

describe('M-A13 R-1b — executed-document reissue command arguments', () => {
  it('inventory takes optional filters and never --apply', () => {
    expect(parseReissueArgs(['inventory'])).toEqual({ mode: 'inventory', envelope_ids: [] });
    expect(parseReissueArgs(['inventory', '--tenant', T, '--envelope', E])).toEqual({ mode: 'inventory', tenant_id: T, envelope_ids: [E] });
    expect(() => parseReissueArgs(['inventory', '--apply'])).toThrow(/read-only/);
  });

  it('reissue is a dry run unless --apply is given', () => {
    expect(parseReissueArgs(['reissue', '--tenant', T, '--envelope', E, '--reason', 'typed signature'])).toMatchObject({ apply: false, reason: 'typed signature' });
    expect(parseReissueArgs(['reissue', '--tenant', T, '--envelope', E, '--reason', 'x', '--apply'])).toMatchObject({ apply: true });
  });

  it('reissue needs a tenant, an envelope and a reason; ids must be UUIDs', () => {
    expect(() => parseReissueArgs(['reissue', '--envelope', E, '--reason', 'x'])).toThrow(/--tenant/);
    expect(() => parseReissueArgs(['reissue', '--tenant', T, '--reason', 'x'])).toThrow(/--envelope/);
    expect(() => parseReissueArgs(['reissue', '--tenant', T, '--envelope', E])).toThrow(/--reason/);
    expect(() => parseReissueArgs(['reissue', '--tenant', 'nope', '--envelope', E, '--reason', 'x'])).toThrow(/UUID/);
    expect(() => parseReissueArgs(['delete'])).toThrow(/inventory/);
  });
});
