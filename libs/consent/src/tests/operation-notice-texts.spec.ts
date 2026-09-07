import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CONVERSATION_NOTICE_OPERATIONS,
  OPERATION_NOTICE_CURRENT_VERSION,
  renderOperationNotice,
  hashOperationNotice,
} from '../lib/operation-notice-texts.js';

// CI-B1 (Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED §4.4) — the
// versioned disclosure/notice registry for recording/transcription/ai_processing.
// Mirrors the consent-texts.ts discipline: deterministic render, sha256 of the
// EXACT rendered text as a reproducible evidence anchor, frozen versions.
describe('operation-notice-texts — conversation-operation disclosure registry', () => {
  const TENANT = '11111111-1111-7111-8111-111111111111';

  it('covers exactly the three conversation operations with a current version each', () => {
    expect([...CONVERSATION_NOTICE_OPERATIONS]).toEqual([
      'recording',
      'transcription',
      'ai_processing',
    ]);
    expect(OPERATION_NOTICE_CURRENT_VERSION).toEqual({
      recording: 'recording-notice-v1',
      transcription: 'transcription-notice-v1',
      ai_processing: 'ai-processing-notice-v1',
    });
  });

  it('renders deterministically (same version + tenant → identical bytes)', () => {
    for (const op of CONVERSATION_NOTICE_OPERATIONS) {
      const version = OPERATION_NOTICE_CURRENT_VERSION[op];
      const a = renderOperationNotice(version, { recipient_tenant_id: TENANT });
      const b = renderOperationNotice(version, { recipient_tenant_id: TENANT });
      expect(a).toBe(b);
      expect(a).toContain(TENANT);
      expect(a.length).toBeGreaterThan(0);
    }
  });

  it('hash is sha256 of the exact rendered text (reproducible evidence preimage)', () => {
    for (const op of CONVERSATION_NOTICE_OPERATIONS) {
      const version = OPERATION_NOTICE_CURRENT_VERSION[op];
      const ctx = { recipient_tenant_id: TENANT };
      const rendered = renderOperationNotice(version, ctx);
      const expected = createHash('sha256').update(rendered, 'utf8').digest('hex');
      const evidence = hashOperationNotice(version, ctx);
      expect(evidence.version).toBe(version);
      expect(evidence.hash).toBe(expected);
      // Reproducible from the version + tenant alone (the forensic contract).
      expect(hashOperationNotice(version, ctx).hash).toBe(evidence.hash);
    }
  });

  it('distinct operations produce distinct disclosure text + hashes', () => {
    const hashes = CONVERSATION_NOTICE_OPERATIONS.map(
      (op) =>
        hashOperationNotice(OPERATION_NOTICE_CURRENT_VERSION[op], {
          recipient_tenant_id: TENANT,
        }).hash,
    );
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('different recipient tenant → different preimage/hash', () => {
    const v = OPERATION_NOTICE_CURRENT_VERSION.transcription;
    const h1 = hashOperationNotice(v, { recipient_tenant_id: TENANT }).hash;
    const h2 = hashOperationNotice(v, {
      recipient_tenant_id: '22222222-2222-7222-8222-222222222222',
    }).hash;
    expect(h1).not.toBe(h2);
  });

  it('unknown version throws (fail-closed — never a silent empty preimage)', () => {
    expect(() =>
      renderOperationNotice('transcription-notice-v999', {
        recipient_tenant_id: TENANT,
      }),
    ).toThrow(/unknown operation notice version/);
  });
});
