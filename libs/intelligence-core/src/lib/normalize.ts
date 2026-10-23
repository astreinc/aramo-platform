import { createHash, createHmac } from 'node:crypto';

// ATI-SEP-1 T1/T3 — identifier normalization, the government-identifier token,
// name comparison and canonical content hashing. Pure functions only.

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * E.164-ish: '+' followed by the digits. A bare 10-digit number is read as a
 * NANP number (+1). Any input that already carries a '+' keeps its own country code.
 */
export function normalizePhone(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

export const INTELLIGENCE_GOV_ID_TOKEN_KEY_ENV = 'INTELLIGENCE_GOV_ID_TOKEN_KEY';
const MIN_KEY_LENGTH = 32;

export class GovIdTokenizationUnavailableError extends Error {
  constructor() {
    super(
      `${INTELLIGENCE_GOV_ID_TOKEN_KEY_ENV} is not configured (>= ${MIN_KEY_LENGTH} characters) — government identifiers cannot be accepted.`,
    );
    this.name = 'GovIdTokenizationUnavailableError';
  }
}

/**
 * ADR-0036 §5.6 — a government identifier is stored ONLY as
 * HMAC-SHA256(key, JURISDICTION:CLASS:VALUE) in lowercase hex. The raw value is
 * normalized (uppercase, alphanumerics only) so formatting never changes the token.
 */
export class GovIdTokenizer {
  private constructor(private readonly key: string | null) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): GovIdTokenizer {
    const key = env[INTELLIGENCE_GOV_ID_TOKEN_KEY_ENV]?.trim() ?? '';
    return new GovIdTokenizer(key.length >= MIN_KEY_LENGTH ? key : null);
  }

  static withKey(key: string): GovIdTokenizer {
    if (key.length < MIN_KEY_LENGTH) throw new GovIdTokenizationUnavailableError();
    return new GovIdTokenizer(key);
  }

  get available(): boolean {
    return this.key !== null;
  }

  token(jurisdiction: string, identifierClass: string, raw: string): string {
    if (this.key === null) throw new GovIdTokenizationUnavailableError();
    const value = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const material = `${jurisdiction.toUpperCase()}:${identifierClass.toUpperCase()}:${value}`;
    return createHmac('sha256', this.key).update(material, 'utf8').digest('hex');
  }
}

// ── names ────────────────────────────────────────────────────────────────────

export interface NameSnapshot {
  first?: string;
  last?: string;
  aliases?: string[];
}

export function normalizeNamePart(value: string | undefined): string {
  if (value === undefined) return '';
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeNames(names: NameSnapshot | undefined): NameSnapshot {
  if (!names) return {};
  const out: NameSnapshot = {};
  const first = normalizeNamePart(names.first);
  const last = normalizeNamePart(names.last);
  if (first) out.first = first;
  if (last) out.last = last;
  const aliases = (names.aliases ?? []).map(normalizeNamePart).filter((a) => a.length > 0);
  if (aliases.length > 0) out.aliases = [...new Set(aliases)].sort();
  return out;
}

function hasName(n: NameSnapshot): boolean {
  return Boolean(n.first || n.last || (n.aliases && n.aliases.length > 0));
}

function fullNames(n: NameSnapshot): string[] {
  const out = new Set<string>(n.aliases ?? []);
  const full = [n.first, n.last].filter(Boolean).join(' ');
  if (full) out.add(full);
  return [...out];
}

function firstCompatible(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true;
  if (a === b) return true;
  // An initial is compatible with a full first name ("p" ~ "priya").
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  return a.startsWith(b) || b.startsWith(a);
}

/** Two (normalized) name snapshots plausibly name the same person. */
export function namesMatch(a: NameSnapshot, b: NameSnapshot): boolean {
  if (!hasName(a) || !hasName(b)) return true;
  if (a.last && b.last && a.last === b.last && firstCompatible(a.first, b.first)) return true;
  const fa = fullNames(a);
  const fb = new Set(fullNames(b));
  return fa.some((x) => fb.has(x));
}

/** True only when BOTH sides carry a name and they do not match (absence never conflicts). */
export function namesConflict(a: NameSnapshot, b: NameSnapshot): boolean {
  return hasName(a) && hasName(b) && !namesMatch(a, b);
}

// ── canonical hashing ────────────────────────────────────────────────────────

/** JSON with object keys sorted at every depth (stable across key order). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
