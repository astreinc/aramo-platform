import { describe, expect, it } from 'vitest';

import { canonicalSignEventType } from '../lib/event-type.js';

// Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED §3.6 — historical esign.* event
// rows (never rewritten) route and verify like their renamed sign.* equivalents.
describe('canonicalSignEventType', () => {
  it('maps a historical esign.* name to its sign.* equivalent', () => {
    expect(canonicalSignEventType('esign.envelope.executed.v1')).toBe('sign.envelope.executed.v1');
    expect(canonicalSignEventType('esign.envelope.declined.v1')).toBe('sign.envelope.declined.v1');
  });
  it('leaves current and unrelated names unchanged', () => {
    expect(canonicalSignEventType('sign.envelope.executed.v1')).toBe('sign.envelope.executed.v1');
    expect(canonicalSignEventType('design.envelope.executed.v1')).toBe('design.envelope.executed.v1');
    expect(canonicalSignEventType('pipeline.stage.changed')).toBe('pipeline.stage.changed');
  });
});
