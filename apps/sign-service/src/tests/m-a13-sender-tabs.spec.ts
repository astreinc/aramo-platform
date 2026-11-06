import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ENVELOPE_TABS } from '../app/sender/sender-envelope.service.js';

// Aramo-Sign-Mobile-Amendment-M-A13 (LOCKED) #13 — the web dashboard's "Declined or
// expired" card links to the sender list tab follow_up (declined + expired).

describe('M-A13 #13 — sender list tabs', () => {
  it('follow_up lists declined and expired envelopes', () => {
    expect(ENVELOPE_TABS['follow_up']).toEqual(['DECLINED', 'EXPIRED']);
  });

  it('the OpenAPI SenderTab enum names every server tab', () => {
    const yaml = readFileSync(resolve(__dirname, '../../../../openapi/sign.yaml'), 'utf8');
    const block = yaml.slice(yaml.indexOf('    SenderTab:'));
    const m = /enum: \[([^\]]+)\]/.exec(block);
    const tabs = (m?.[1] ?? '').split(',').map((t) => t.trim());
    expect(tabs.sort()).toEqual(Object.keys(ENVELOPE_TABS).sort());
  });
});
