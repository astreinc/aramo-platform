import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { IdentityRepository } from '@aramo/identity';
import { MAILER_PORT, type MailerPort } from '@aramo/mailer';
import {
  SIGN_DATE_FORMATS,
  SIGN_FIELD_SIZES,
  type SignDateFormat,
  type SignFieldSize,
  type SignUserProfileValue,
  type SignUserSettingsValue,
  SignUserProfileRepository,
} from '@aramo/sign';

// Aramo Sign Mobile M-A12 §2 W1-E — the signed-in user's own Sign profile, settings and
// "Report app issue". Keyed by the verified token's (tenant, subject) only; web and mobile.
//
//   GET/PUT /v1/sign/me/profile    display_name (1..120) + optional title, company, address
//                                  lines, city, region, postal_code, country (ISO-2), phone
//                                  (E.164); each optional field nullable, at most 200.
//   GET/PUT /v1/sign/me/settings   date_format MM/DD/YYYY | DD/MM/YYYY | YYYY-MM-DD,
//                                  default_field_size S | M | L (defaults MM/DD/YYYY, M).
//   POST /v1/sign/me/app-issues    202. 5 per user per rolling hour (429). Emailed to
//                                  support through the mailer (SIGN_APP_ISSUE_EMAIL, no
//                                  default: unset ⇒ 503, the feature is off). The message
//                                  is never stored or logged: only its metadata is kept,
//                                  for the rate limit. No document data, tokens or logs.
//
// Refusals (400 VALIDATION_ERROR, stable details.reason):
//   invalid_body                the body is not a JSON object
//   unknown_field               a property outside the documented shape (details.field)
//   invalid_display_name        display_name missing, or not 1..120 characters
//   invalid_profile_field       an optional field that is not text of at most 200 (details.field)
//   invalid_country             country is not an ISO 3166-1 alpha-2 code
//   invalid_phone               phone is not E.164 (+ and up to 15 digits)
//   invalid_date_format / invalid_default_field_size
//   invalid_app_issue           an app-issue field missing or too long (details.field)

export const PROFILE_OPTIONAL_FIELDS = ['title', 'company', 'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country', 'phone'] as const;
const PROFILE_FIELDS = new Set<string>(['display_name', ...PROFILE_OPTIONAL_FIELDS]);
const SETTINGS_FIELDS = new Set<string>(['date_format', 'default_field_size']);
const APP_ISSUE_FIELDS = new Set<string>(['message', 'app_version', 'os', 'os_version', 'device_model', 'screen']);
export const DISPLAY_NAME_MAX = 120;
export const PROFILE_FIELD_MAX = 200;
export const APP_ISSUE_MESSAGE_MAX = 2000;
export const APP_ISSUE_LIMIT_PER_HOUR = 5;
const APP_ISSUE_WINDOW_MS = 60 * 60 * 1000;
const COUNTRY_RE = /^[A-Z]{2}$/;
const E164_RE = /^\+[1-9][0-9]{1,14}$/;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function bad(requestId: string, message: string, reason: string, field?: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, details: { reason, ...(field !== undefined ? { field } : {}) } });
}

function objectBody(body: unknown, allowed: ReadonlySet<string>, requestId: string): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad(requestId, 'The body must be a JSON object', 'invalid_body');
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) throw bad(requestId, `Unknown field: ${k.slice(0, 64)}`, 'unknown_field', k.slice(0, 64));
  }
  return o;
}

export function validateProfile(body: unknown, requestId: string): SignUserProfileValue {
  const o = objectBody(body, PROFILE_FIELDS, requestId);
  const dn = typeof o['display_name'] === 'string' ? o['display_name'].trim() : '';
  if (dn.length === 0 || dn.length > DISPLAY_NAME_MAX) throw bad(requestId, `display_name must be 1 to ${DISPLAY_NAME_MAX} characters`, 'invalid_display_name', 'display_name');
  const opt = (k: (typeof PROFILE_OPTIONAL_FIELDS)[number]): string | null => {
    const v = o[k];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || v.trim().length > PROFILE_FIELD_MAX) throw bad(requestId, `${k} must be text of at most ${PROFILE_FIELD_MAX} characters`, 'invalid_profile_field', k);
    const t = v.trim();
    return t.length === 0 ? null : t;
  };
  const country = opt('country')?.toUpperCase() ?? null;
  if (country !== null && !COUNTRY_RE.test(country)) throw bad(requestId, 'country must be a two-letter ISO 3166-1 code', 'invalid_country', 'country');
  const phoneRaw = opt('phone');
  const phone = phoneRaw === null ? null : phoneRaw.replace(/[\s().-]/g, '');
  if (phone !== null && !E164_RE.test(phone)) throw bad(requestId, 'phone must be in international format, e.g. +14155550123', 'invalid_phone', 'phone');
  return {
    display_name: dn,
    title: opt('title'),
    company: opt('company'),
    address_line1: opt('address_line1'),
    address_line2: opt('address_line2'),
    city: opt('city'),
    region: opt('region'),
    postal_code: opt('postal_code'),
    country,
    phone,
  };
}

export function validateSettings(body: unknown, requestId: string): SignUserSettingsValue {
  const o = objectBody(body, SETTINGS_FIELDS, requestId);
  const df = o['date_format'];
  if (typeof df !== 'string' || !(SIGN_DATE_FORMATS as readonly string[]).includes(df)) {
    throw bad(requestId, 'date_format must be MM/DD/YYYY, DD/MM/YYYY or YYYY-MM-DD', 'invalid_date_format', 'date_format');
  }
  const fs = o['default_field_size'];
  if (typeof fs !== 'string' || !(SIGN_FIELD_SIZES as readonly string[]).includes(fs)) {
    throw bad(requestId, 'default_field_size must be S, M or L', 'invalid_default_field_size', 'default_field_size');
  }
  return { date_format: df as SignDateFormat, default_field_size: fs as SignFieldSize };
}

export interface AppIssueInput {
  message: string;
  app_version: string;
  os: 'ios' | 'android';
  os_version: string;
  device_model: string;
  screen: string | null;
}

export function validateAppIssue(body: unknown, requestId: string): AppIssueInput {
  const o = objectBody(body, APP_ISSUE_FIELDS, requestId);
  const text = (k: string, max: number, required: boolean): string | null => {
    const v = o[k];
    if ((v === undefined || v === null) && !required) return null;
    const t = typeof v === 'string' ? v.trim() : '';
    if (t.length === 0 ? required : t.length > max) throw bad(requestId, `${k} is required (at most ${max} characters)`, 'invalid_app_issue', k);
    return t.length === 0 ? null : t;
  };
  const message = text('message', APP_ISSUE_MESSAGE_MAX, true) as string;
  const app_version = text('app_version', 50, true) as string;
  const os = o['os'];
  if (os !== 'ios' && os !== 'android') throw bad(requestId, 'os must be ios or android', 'invalid_app_issue', 'os');
  const os_version = text('os_version', 50, true) as string;
  const device_model = text('device_model', 100, true) as string;
  const screen = text('screen', 100, false);
  return { message, app_version, os, os_version, device_model, screen };
}

/** The support address for app issues; null (feature off) when unset or not an email. No default. */
export function appIssueSupportAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env['SIGN_APP_ISSUE_EMAIL']?.trim() ?? '';
  return v.length > 0 && v.length <= 254 && EMAIL_RE.test(v) ? v : null;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

@Injectable()
export class SignMeProfileService {
  private readonly log = new Logger(SignMeProfileService.name);

  constructor(
    private readonly repo: SignUserProfileRepository,
    private readonly identity: IdentityRepository,
    @Optional() @Inject(MAILER_PORT) private readonly mailer?: MailerPort,
  ) {}

  private async account(auth: AuthContextType): Promise<{ email: string | null; display_name: string | null }> {
    const user = await this.identity.findUserById(auth.sub).catch(() => null);
    return { email: user?.email?.trim() || null, display_name: user?.display_name?.trim() || null };
  }

  /** The stored profile, or (none yet) the account's name with every optional field null. */
  async getProfile(auth: AuthContextType) {
    const row = await this.repo.getProfile(auth.tenant_id, auth.sub);
    const acct = await this.account(auth);
    if (row !== null) {
      const { updated_at, ...value } = row;
      return { ...value, email: acct.email, updated_at: updated_at.toISOString() };
    }
    const fallback = (acct.display_name ?? acct.email ?? '').slice(0, DISPLAY_NAME_MAX);
    return {
      display_name: fallback,
      title: null,
      company: null,
      address_line1: null,
      address_line2: null,
      city: null,
      region: null,
      postal_code: null,
      country: null,
      phone: null,
      email: acct.email,
      updated_at: null,
    };
  }

  async putProfile(auth: AuthContextType, body: unknown, requestId: string) {
    const value = validateProfile(body, requestId);
    const row = await this.repo.putProfile(auth.tenant_id, auth.sub, value);
    const acct = await this.account(auth);
    const { updated_at, ...rest } = row;
    return { ...rest, email: acct.email, updated_at: updated_at.toISOString() };
  }

  async getSettings(auth: AuthContextType) {
    return this.repo.getSettings(auth.tenant_id, auth.sub);
  }

  async putSettings(auth: AuthContextType, body: unknown, requestId: string) {
    return this.repo.putSettings(auth.tenant_id, auth.sub, validateSettings(body, requestId));
  }

  async reportIssue(auth: AuthContextType, body: unknown, requestId: string, now: Date = new Date()): Promise<{ received: true; reference: string }> {
    const input = validateAppIssue(body, requestId);
    const to = appIssueSupportAddress();
    if (to === null || this.mailer === undefined) {
      throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'Reporting an issue is not available right now', 503, { requestId, details: { reason: 'app_issues_unavailable' } });
    }
    const since = new Date(now.getTime() - APP_ISSUE_WINDOW_MS);
    if ((await this.repo.countAppIssuesSince(auth.tenant_id, auth.sub, since)) >= APP_ISSUE_LIMIT_PER_HOUR) {
      const oldest = await this.repo.oldestAppIssueSince(auth.tenant_id, auth.sub, since);
      const retryAt = new Date((oldest ?? now).getTime() + APP_ISSUE_WINDOW_MS);
      const seconds = Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000));
      throw new AramoError('INVALID_REQUEST', 'You have reported several issues in the last hour. Please try again later.', 429, {
        requestId,
        details: { reason: 'app_issue_rate_limited', retry_after_seconds: seconds, retry_at: retryAt.toISOString() },
      });
    }
    const reference = await this.repo.recordAppIssue({ tenant_id: auth.tenant_id, user_id: auth.sub, os: input.os, app_version: input.app_version, now });
    const acct = await this.account(auth);
    const lines: Array<[string, string]> = [
      ['Reference', reference],
      ['Account email', acct.email ?? '(none)'],
      ['User id', auth.sub],
      ['Tenant id', auth.tenant_id],
      ['App version', input.app_version],
      ['OS', `${input.os} ${input.os_version}`],
      ['Device', input.device_model],
      ['Screen', input.screen ?? '(not given)'],
      ['Received', now.toISOString()],
    ];
    const text = `${lines.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${input.message}\n`;
    const html = `<table>${lines.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}</table><p style="white-space:pre-wrap">${esc(input.message)}</p>`;
    try {
      await this.mailer.send({ to, subject: `Aramo Sign app issue ${reference} (${input.os})`, html, text });
    } catch (e) {
      // Not delivered: the report does not count against the limit. Never the message.
      await this.repo.removeAppIssue(reference).catch(() => undefined);
      this.log.warn(`app issue ${reference} not delivered (${e instanceof Error ? e.name : 'error'})`);
      throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'Your report could not be sent. Please try again later.', 503, { requestId, details: { reason: 'app_issue_delivery_failed' } });
    }
    this.log.log(`app issue ${reference} delivered to support (${input.os})`);
    return { received: true, reference };
  }
}
