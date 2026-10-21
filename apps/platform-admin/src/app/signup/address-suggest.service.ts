import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { US_STATE_CODES } from '@aramo/identity';

// Aramo-Sign-Signup-Federated-Owner Amendment A1 (LOCKED) §2.3 — address
// autocomplete for the organization-details step, proxied server-side so the
// provider key never reaches the browser and no third-party script loads on the
// signup page. PO decision 2026-10-21: Geoapify (its free commercial tier
// requires the "Powered by Geoapify" attribution, returned with the results).
//
//   SIGN_ADDRESS_PROVIDER      'geoapify' (anything else / unset → manual entry only)
//   SIGN_ADDRESS_PROVIDER_KEY  the provider API key (secret; never logged)
//   SIGN_ADDRESS_PROVIDER_BASE_URL  optional override (tests point it at a stand-in)
//
// Fails open: unconfigured, slow (> 2 s), rate-limited or failing → `available:
// false` and the page keeps working as plain fields. Results are United States
// (50 states + DC) only; a suggestion is never proof — `complete` re-validates.

export interface AddressSuggestion {
  label: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state_province: string;
  postal_code: string;
}

export interface AddressSuggestResult {
  available: boolean;
  suggestions: AddressSuggestion[];
  attribution: { label: string; url: string } | null;
}

const TIMEOUT_MS = 2000;
const LIMIT = 5;
const WINDOW_MS = 10 * 60 * 1000;
const PER_TOKEN_MAX = 60;
const PER_IP_MAX = 120;
const GEOAPIFY_ATTRIBUTION = { label: 'Powered by Geoapify', url: 'https://www.geoapify.com/' } as const;
const UNAVAILABLE: AddressSuggestResult = { available: false, suggestions: [], attribution: null };

@Injectable()
export class AddressSuggestService {
  private readonly log = new Logger(AddressSuggestService.name);
  private readonly windows = new Map<string, { start: number; count: number }>();

  /** Fixed-window limiter (per process; correct on the single box). */
  private allow(key: string, max: number, now: number): boolean {
    const w = this.windows.get(key);
    if (w === undefined || now - w.start >= WINDOW_MS) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= max) return false;
    w.count += 1;
    return true;
  }

  reset(): void {
    this.windows.clear();
  }

  async suggest(input: { text: unknown; token: string; ip: string; now?: number }, env: NodeJS.ProcessEnv = process.env): Promise<AddressSuggestResult> {
    const provider = env['SIGN_ADDRESS_PROVIDER']?.trim().toLowerCase();
    const key = env['SIGN_ADDRESS_PROVIDER_KEY']?.trim();
    if (provider !== 'geoapify' || key === undefined || key === '') return UNAVAILABLE;
    const text = typeof input.text === 'string' ? input.text.replace(/\s+/g, ' ').trim() : '';
    if (text.length < 3 || text.length > 200) return { available: true, suggestions: [], attribution: GEOAPIFY_ATTRIBUTION };
    const now = input.now ?? Date.now();
    const tokenKey = `t:${createHash('sha256').update(input.token).digest('base64url')}`;
    if (!this.allow(tokenKey, PER_TOKEN_MAX, now) || !this.allow(`ip:${input.ip}`, PER_IP_MAX, now)) return UNAVAILABLE;

    const base = (env['SIGN_ADDRESS_PROVIDER_BASE_URL']?.trim() || 'https://api.geoapify.com').replace(/\/+$/, '');
    const url = `${base}/v1/geocode/autocomplete?${new URLSearchParams({
      text,
      filter: 'countrycode:us',
      format: 'json',
      lang: 'en',
      limit: String(LIMIT),
      apiKey: key,
    }).toString()}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) {
        this.log.warn(`address provider answered ${res.status}`);
        return UNAVAILABLE;
      }
      const body = (await res.json()) as { results?: unknown };
      return { available: true, suggestions: geoapifySuggestions(body.results), attribution: GEOAPIFY_ATTRIBUTION };
    } catch (err) {
      this.log.warn(`address provider unavailable: ${(err as Error).name}`);
      return UNAVAILABLE;
    } finally {
      clearTimeout(timer);
    }
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Geoapify `results[]` → US (50 states + DC) suggestions with a street line and a city. */
export function geoapifySuggestions(results: unknown): AddressSuggestion[] {
  if (!Array.isArray(results)) return [];
  const out: AddressSuggestion[] = [];
  for (const r of results as Record<string, unknown>[]) {
    if (str(r['country_code'])?.toLowerCase() !== 'us') continue;
    const state = str(r['state_code'])?.toUpperCase() ?? null;
    if (state === null || !US_STATE_CODES.has(state)) continue;
    const houseStreet = [str(r['housenumber']), str(r['street'])].filter((x) => x !== null).join(' ');
    const line1 = houseStreet !== '' ? houseStreet : str(r['address_line1']);
    const city = str(r['city']) ?? str(r['town']) ?? str(r['village']);
    if (line1 === null || city === null) continue;
    const zip = str(r['postcode']);
    out.push({
      label: str(r['formatted']) ?? `${line1}, ${city}, ${state}${zip === null ? '' : ` ${zip}`}`,
      address_line1: line1,
      address_line2: null,
      city,
      state_province: state,
      postal_code: zip !== null && /^\d{5}(-\d{4})?$/.test(zip) ? zip : '',
    });
    if (out.length >= LIMIT) break;
  }
  return out;
}
