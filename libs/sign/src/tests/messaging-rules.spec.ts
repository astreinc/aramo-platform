import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QUIET_HOURS,
  isE164,
  isQuietHours,
  isTimeZone,
  maskPhone,
  parseInboundKeyword,
  phoneHash,
  quietHoursFromEnv,
  rateLimitExceeded,
  recipientTimeZones,
  tenantMessagingLimitsFromEnv,
} from '../lib/messaging/messaging-rules.js';

// Feature-Parity §1.7 / §1.8 / §1.9 — the pure messaging rules.

describe('messaging rules — phone numbers', () => {
  it('accepts E.164 only', () => {
    expect(isE164('+14155550123')).toBe(true);
    expect(isE164('+919876543210')).toBe(true);
    for (const bad of ['14155550123', '+0123456789', '+1 415 555 0123', '+1234567', '+1234567890123456', '', null, 42]) expect(isE164(bad)).toBe(false);
  });

  it('masks all but the first country digit and the last two digits', () => {
    expect(maskPhone('+14155550123')).toBe(`+1${'•'.repeat(8)}23`);
    expect(maskPhone('+14155550123')).not.toContain('555');
  });

  it('hashes deterministically and never contains the number', () => {
    expect(phoneHash('+14155550123')).toBe(phoneHash('+14155550123'));
    expect(phoneHash('+14155550123')).not.toBe(phoneHash('+14155550124'));
    expect(phoneHash('+14155550123')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('messaging rules — opt-out keywords', () => {
  it('recognizes STOP / START / HELP on the whole trimmed message, case-blind', () => {
    expect(parseInboundKeyword(' stop ')).toBe('OPT_OUT');
    expect(parseInboundKeyword('UNSUBSCRIBE')).toBe('OPT_OUT');
    expect(parseInboundKeyword('Start')).toBe('OPT_IN');
    expect(parseInboundKeyword('help')).toBe('HELP');
    expect(parseInboundKeyword('please stop')).toBeNull();
    expect(parseInboundKeyword(undefined)).toBeNull();
  });
});

describe('messaging rules — quiet hours', () => {
  it('defaults to 21-8, accepts START-END, and "off" disables', () => {
    expect(quietHoursFromEnv({})).toEqual(DEFAULT_QUIET_HOURS);
    expect(quietHoursFromEnv({ SIGN_MESSAGING_QUIET_HOURS: '22-7' })).toEqual({ start: 22, end: 7 });
    expect(quietHoursFromEnv({ SIGN_MESSAGING_QUIET_HOURS: 'off' })).toBeNull();
    expect(quietHoursFromEnv({ SIGN_MESSAGING_QUIET_HOURS: 'nonsense' })).toEqual(DEFAULT_QUIET_HOURS);
  });

  it('is evaluated in the recipient zone; a North American number is quiet if any contiguous US zone is', () => {
    const q = DEFAULT_QUIET_HOURS;
    // 2026-07-01 15:00 UTC = 11:00 New York, 08:00 Los Angeles → allowed everywhere.
    expect(isQuietHours(new Date('2026-07-01T15:00:00Z'), recipientTimeZones('+14155550123', null), q)).toBe(false);
    // 2026-07-01 13:00 UTC = 09:00 New York but 06:00 Los Angeles → quiet.
    expect(isQuietHours(new Date('2026-07-01T13:00:00Z'), recipientTimeZones('+14155550123', null), q)).toBe(true);
    // An explicit zone wins.
    expect(isQuietHours(new Date('2026-07-01T13:00:00Z'), recipientTimeZones('+14155550123', 'America/New_York'), q)).toBe(false);
    // India → Asia/Kolkata (UTC+5:30): 16:00 UTC = 21:30 → quiet.
    expect(recipientTimeZones('+919876543210', null)).toEqual(['Asia/Kolkata']);
    expect(isQuietHours(new Date('2026-07-01T16:00:00Z'), ['Asia/Kolkata'], q)).toBe(true);
    expect(isQuietHours(new Date('2026-07-01T16:00:00Z'), ['Asia/Kolkata'], null)).toBe(false);
  });

  it('validates IANA zones and falls back to SIGN_MESSAGING_DEFAULT_TIMEZONE / UTC', () => {
    expect(isTimeZone('Europe/London')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(recipientTimeZones('+447700900123', null, {})).toEqual(['UTC']);
    expect(recipientTimeZones('+447700900123', null, { SIGN_MESSAGING_DEFAULT_TIMEZONE: 'Europe/London' })).toEqual(['Europe/London']);
    expect(recipientTimeZones('+447700900123', 'Bad/Zone', {})).toEqual(['UTC']);
  });
});

describe('messaging rules — per-tenant rate limits', () => {
  it('defaults to 100 an hour and 500 a day; env overrides positive integers only', () => {
    expect(tenantMessagingLimitsFromEnv({})).toEqual({ hourly: 100, daily: 500 });
    expect(tenantMessagingLimitsFromEnv({ SIGN_MESSAGING_TENANT_HOURLY_LIMIT: '5', SIGN_MESSAGING_TENANT_DAILY_LIMIT: '-1' })).toEqual({ hourly: 5, daily: 500 });
    expect(rateLimitExceeded({ last_hour: 4, last_day: 4 }, { hourly: 5, daily: 10 })).toBe(false);
    expect(rateLimitExceeded({ last_hour: 5, last_day: 5 }, { hourly: 5, daily: 10 })).toBe(true);
    expect(rateLimitExceeded({ last_hour: 0, last_day: 10 }, { hourly: 5, daily: 10 })).toBe(true);
  });
});
