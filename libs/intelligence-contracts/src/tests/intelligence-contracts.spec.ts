import { describe, expect, it } from 'vitest';

import {
  ATS_TALENT_EVENT_TYPES,
  EVENT_VERSION,
  GOLDEN_TALENT_PROFILE_UPDATED,
  INTELLIGENCE_EVENT_TYPES,
  SOURCE_SYSTEM_ARAMO_ATS,
  isAtsTalentEventEnvelope,
  isAtsTalentEventType,
  isIntelligenceEventType,
} from '../index.js';

// ATI-SEP-1 T0 — the shared ATS ⇄ TI contract constants (ADR-0036 Decision 3).

const ENVELOPE = {
  event_id: '019a0000-0000-7000-8000-000000000001',
  event_type: 'talent.created',
  event_version: 'v1',
  tenant_id: '019a0000-0000-7000-8000-000000000002',
  talent_id: '019a0000-0000-7000-8000-000000000003',
  occurred_at: '2026-10-23T00:00:00.000Z',
};

describe('intelligence-contracts — event names', () => {
  it('pins the business-fact event names and version', () => {
    expect([...ATS_TALENT_EVENT_TYPES]).toEqual(['talent.created', 'talent.profile_updated', 'talent.erased']);
    expect([...INTELLIGENCE_EVENT_TYPES]).toEqual(['golden_talent.profile_updated']);
    expect(GOLDEN_TALENT_PROFILE_UPDATED).toBe('golden_talent.profile_updated');
    expect(EVENT_VERSION).toBe('v1');
    expect(SOURCE_SYSTEM_ARAMO_ATS).toBe('ARAMO_ATS');
  });

  it('classifies event types by direction', () => {
    expect(isAtsTalentEventType('talent.erased')).toBe(true);
    expect(isAtsTalentEventType('golden_talent.profile_updated')).toBe(false);
    expect(isIntelligenceEventType('golden_talent.profile_updated')).toBe(true);
    expect(isIntelligenceEventType('talent.created')).toBe(false);
    expect(isAtsTalentEventType(42)).toBe(false);
  });
});

describe('intelligence-contracts — ATS envelope (ids only)', () => {
  it('accepts a well-formed v1 envelope', () => {
    expect(isAtsTalentEventEnvelope(ENVELOPE)).toBe(true);
  });

  it('refuses any extra key (no PII or document reference rides the envelope)', () => {
    expect(isAtsTalentEventEnvelope({ ...ENVELOPE, email: 'a@example.com' })).toBe(false);
    expect(isAtsTalentEventEnvelope({ ...ENVELOPE, document_url: 'https://x' })).toBe(false);
  });

  it('refuses an unknown type, another version, or an empty id', () => {
    expect(isAtsTalentEventEnvelope({ ...ENVELOPE, event_type: 'talent.deleted' })).toBe(false);
    expect(isAtsTalentEventEnvelope({ ...ENVELOPE, event_version: 'v2' })).toBe(false);
    expect(isAtsTalentEventEnvelope({ ...ENVELOPE, talent_id: '' })).toBe(false);
    expect(isAtsTalentEventEnvelope(null)).toBe(false);
    expect(isAtsTalentEventEnvelope([ENVELOPE])).toBe(false);
  });
});
