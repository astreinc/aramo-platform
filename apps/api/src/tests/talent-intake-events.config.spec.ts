import { describe, expect, it } from 'vitest';

import { loadTalentIntakeEventsConfig } from '../talent-intake-consumer/talent-intake-events.config.js';

// ADR-0033 — transport configuration. singlebox is an EXPLICIT production
// transport (single-box topology); eventbridge stays the default and
// structured-log stays an explicit non-prod selection. An unknown value is
// rejected (never an implicit fallback).
describe('loadTalentIntakeEventsConfig — transport selection', () => {
  it('§1 accepts singlebox', () => {
    expect(
      loadTalentIntakeEventsConfig({ TALENT_INTAKE_TRANSPORT: 'singlebox' }).transport,
    ).toBe('singlebox');
  });

  it('§2 defaults to eventbridge when unset (unchanged)', () => {
    expect(loadTalentIntakeEventsConfig({}).transport).toBe('eventbridge');
  });

  it('§3 accepts structured-log (unchanged)', () => {
    expect(
      loadTalentIntakeEventsConfig({ TALENT_INTAKE_TRANSPORT: 'structured-log' }).transport,
    ).toBe('structured-log');
  });

  it('rejects an unknown transport (fail-closed; never an implicit fallback)', () => {
    expect(() =>
      loadTalentIntakeEventsConfig({ TALENT_INTAKE_TRANSPORT: 'bogus' }),
    ).toThrow(/TALENT_INTAKE_TRANSPORT/);
  });
});
