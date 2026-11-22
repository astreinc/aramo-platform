// Client Rule Consolidation C2-5 — one table-driven spec per rule. This file runs under
// vitest (nx run sign-client:test) AND under mobile/sign Jest (jest.config.js roots): it
// uses the shared globals only (describe / it / expect), never a runner import.
import { DEFAULT_SIGN_DATE_FORMAT, SIGN_DATE_FORMATS, SIGN_DATE_PREVIEW_NOTE, formatSignDate, localTimeZone, resolveSignerTimeZone, signDatePreview } from '../index.js';

describe('SIGN_DATE formats (audit row 33)', () => {
  it('lists the three formats; MM/DD/YYYY is the default', () => {
    expect([...SIGN_DATE_FORMATS]).toEqual(['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD']);
    expect(DEFAULT_SIGN_DATE_FORMAT).toBe('MM/DD/YYYY');
  });
});

describe('formatSignDate (C0-2: the signer calendar date in the signer time zone)', () => {
  const boundary = new Date('2026-11-21T02:00:00Z');

  it.each([
    // [instant, format, time zone, expected]
    ['2026-11-21T02:00:00Z', 'YYYY-MM-DD', 'America/New_York', '2026-11-20'],
    ['2026-11-21T02:00:00Z', 'YYYY-MM-DD', 'UTC', '2026-11-21'],
    ['2026-11-21T02:00:00Z', 'YYYY-MM-DD', 'Asia/Kolkata', '2026-11-21'],
    ['2026-11-20T20:00:00Z', 'MM/DD/YYYY', 'Asia/Tokyo', '11/21/2026'],
    ['2026-11-21T02:00:00Z', 'MM/DD/YYYY', 'America/New_York', '11/20/2026'],
    ['2026-11-21T02:00:00Z', 'DD/MM/YYYY', 'America/New_York', '20/11/2026'],
    ['2026-11-21T02:00:00Z', null, 'America/New_York', '11/20/2026'],
    ['2026-11-21T02:00:00Z', 'not-a-format', 'America/New_York', '11/20/2026'],
    ['2026-11-21T02:00:00Z', 'YYYY-MM-DD', 'Mars/Olympus_Mons', '2026-11-21'],
    ['2026-11-04T12:00:00Z', 'DD/MM/YYYY', 'UTC', '04/11/2026'],
  ])('%s as %s in %s → %s', (iso, format, tz, expected) => {
    expect(formatSignDate(new Date(iso), format, tz)).toBe(expected);
  });

  it('without a time zone it formats in UTC (the server default)', () => {
    expect(formatSignDate(boundary, 'YYYY-MM-DD')).toBe('2026-11-21');
    expect(formatSignDate(boundary, undefined)).toBe('11/21/2026');
  });
});

describe('resolveSignerTimeZone', () => {
  it.each([['America/New_York'], ['Europe/London'], ['Asia/Calcutta'], ['UTC']])('keeps %s', (tz) => {
    expect(resolveSignerTimeZone(tz)).toBe(tz);
  });

  it.each([[undefined], [null], [42], [''], ['Mars/Olympus_Mons'], ['America/New_York; DROP'], ['x'.repeat(65)]])('falls back to UTC for %p', (input) => {
    expect(resolveSignerTimeZone(input)).toBe('UTC');
  });
});

describe('signDatePreview (the client preview of the server stamp)', () => {
  const zone = localTimeZone();

  it('reports this runtime time zone', () => {
    expect(typeof zone === 'string' && zone.length > 0).toBe(true);
  });

  it.each([
    ['MM/DD/YYYY', '11/04/2026'],
    ['DD/MM/YYYY', '04/11/2026'],
    ['YYYY-MM-DD', '2026-11-04'],
    [null, '11/04/2026'],
  ])('a local noon on Nov 4 2026 previews %s as %s', (format, expected) => {
    expect(signDatePreview(format, new Date(2026, 10, 4, 12, 0, 0))).toBe(expected);
  });

  it('equals the server stamp for the same instant and zone', () => {
    const now = new Date('2026-11-21T02:00:00Z');
    expect(signDatePreview('YYYY-MM-DD', now)).toBe(formatSignDate(now, 'YYYY-MM-DD', zone ?? 'UTC'));
  });
});

describe('the one preview note (C3, row 33)', () => {
  it('is the same words on web and mobile', () => {
    expect(SIGN_DATE_PREVIEW_NOTE).toBe('filled in at signing');
  });
});
