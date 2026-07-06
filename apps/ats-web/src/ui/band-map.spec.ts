import { describe, expect, it } from 'vitest';

import { PRESENTATION_BANDS, bandLabel, bandTone } from './band-map';

// Drift guard for the FE hand-mirror of libs/talent-trust PRESENTATION_BANDS
// (ats-web can't import the scope:cip lib across the I15 wall). If the backend
// vocab changes, this fixture must change with it — the assertion makes a silent
// drift impossible (the stage-map.spec precedent). R10: every band maps to a
// label + a tone, never a number.

// The canonical ordered set, low→high (libs/talent-trust/src/lib/vocab.ts).
const CANONICAL = [
  'NOT_ESTABLISHED',
  'SELF_ASSERTED',
  'CORROBORATED',
  'INDEPENDENTLY_VERIFIED',
  'AUTHORITATIVE',
] as const;

describe('band-map (BandPill vocab mirror)', () => {
  it('mirrors the canonical PRESENTATION_BANDS set and order', () => {
    expect([...PRESENTATION_BANDS]).toEqual([...CANONICAL]);
  });

  it('maps every band to its label + tone', () => {
    const expected: Record<string, { label: string; tone: string }> = {
      NOT_ESTABLISHED: { label: 'Not established', tone: 'neutral' },
      SELF_ASSERTED: { label: 'Self-asserted', tone: 'warn' },
      CORROBORATED: { label: 'Corroborated', tone: 'info' },
      INDEPENDENTLY_VERIFIED: { label: 'Independently verified', tone: 'ok' },
      AUTHORITATIVE: { label: 'Authoritative', tone: 'brand' },
    };
    for (const band of CANONICAL) {
      expect(bandLabel(band)).toBe(expected[band].label);
      expect(bandTone(band)).toBe(expected[band].tone);
    }
  });

  it('renders a null band as "Not established" / neutral (no TrustState yet)', () => {
    expect(bandLabel(null)).toBe('Not established');
    expect(bandTone(null)).toBe('neutral');
  });

  it('degrades an unknown future band to a humanised label + neutral tone (never a raw enum, never a number)', () => {
    expect(bandLabel('FUTURE_BAND')).toBe('Future band');
    expect(bandTone('FUTURE_BAND')).toBe('neutral');
  });

  it('never emits a numeric or star label', () => {
    for (const band of [...CANONICAL, null, 'WEIRD']) {
      const label = bandLabel(band as string | null);
      expect(label).not.toMatch(/[0-9★]/);
    }
  });
});
