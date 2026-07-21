import { describe, expect, it } from 'vitest';

import type { SyncStatus } from '../lib/channel-posting.types.js';
import {
  planPublishableAction,
  shouldExpire,
  type ExistingPostingState,
} from '../lib/posting-transition.js';

const HASH = 'hash-abc';

function state(over: Partial<ExistingPostingState>): ExistingPostingState {
  return {
    content_hash: HASH,
    external_posting_id: 'src-posting-1',
    sync_status: 'LIVE',
    tombstoned_at: null,
    ...over,
  };
}

// SRC-2 PR-3 (R4) — the transition table, every SYNC_STATUSES entry exercised.
describe('planPublishableAction', () => {
  it('no existing state → CREATE', () => {
    expect(planPublishableAction({ contentHash: HASH, existing: null })).toBe(
      'CREATE',
    );
  });

  it('state without external_posting_id → CREATE (prior create never landed)', () => {
    expect(
      planPublishableAction({
        contentHash: HASH,
        existing: state({ external_posting_id: null, sync_status: 'PENDING_CREATE' }),
      }),
    ).toBe('CREATE');
  });

  it('content changed → UPDATE', () => {
    expect(
      planPublishableAction({
        contentHash: 'hash-new',
        existing: state({ content_hash: 'hash-old', sync_status: 'LIVE' }),
      }),
    ).toBe('UPDATE');
  });

  it('content same + LIVE → NOOP', () => {
    expect(
      planPublishableAction({ contentHash: HASH, existing: state({ sync_status: 'LIVE' }) }),
    ).toBe('NOOP');
  });

  it('content same + ERROR (with external id) → UPDATE (re-drive to LIVE)', () => {
    expect(
      planPublishableAction({ contentHash: HASH, existing: state({ sync_status: 'ERROR' }) }),
    ).toBe('UPDATE');
  });

  it('content same + PENDING_UPDATE → UPDATE (re-drive)', () => {
    expect(
      planPublishableAction({
        contentHash: HASH,
        existing: state({ sync_status: 'PENDING_UPDATE' }),
      }),
    ).toBe('UPDATE');
  });

  it('content same + EXPIRED but back in publishable set → UPDATE (re-drive/relist)', () => {
    expect(
      planPublishableAction({
        contentHash: HASH,
        existing: state({ sync_status: 'EXPIRED' }),
      }),
    ).toBe('UPDATE');
  });
});

describe('shouldExpire', () => {
  const cases: Array<[SyncStatus, Date | null, boolean]> = [
    ['LIVE', null, true],
    ['ERROR', null, true],
    ['PENDING_CREATE', null, true],
    ['EXPIRED', new Date(0), false],
    ['LIVE', new Date(0), false],
  ];
  it.each(cases)('sync_status=%s tombstoned=%s → %s', (sync_status, tombstoned_at, expected) => {
    expect(shouldExpire({ sync_status, tombstoned_at })).toBe(expected);
  });
});
