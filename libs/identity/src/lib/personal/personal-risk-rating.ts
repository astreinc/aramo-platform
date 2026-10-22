// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) §6.2 — the signup risk
// rating. Rules-based and explainable: every signal that fired is returned with
// the points it added, and the caller stores the whole result (signals + total +
// decision) on the PersonalSignupRequest row. Points and thresholds are
// configuration (SIGN_PERSONAL_RISK_CONFIG, JSON), never code.

export const PERSONAL_RISK_DECISIONS = ['allow', 'step_up', 'review', 'refuse'] as const;
export type PersonalRiskDecision = (typeof PERSONAL_RISK_DECISIONS)[number];

export type NetworkKind = 'hosting' | 'vpn' | 'tor' | 'residential' | 'unknown';
export type RobotVerdict = 'pass' | 'low' | 'fail' | 'unavailable';

export interface PersonalRiskConfig {
  points: {
    robot_low: number;
    network_hosting: number;
    ip_signups: number;
    phone_ip_country_mismatch: number;
    gmail_alias_of_existing: number;
    fast_form: number;
    random_looking: number;
    phone_reused: number;
    // Architect ruling 2026-10-21 — the network country is a risk signal, never a
    // block by itself: outside the allowed set (alone → review) and UNKNOWN
    // (no database / no answer / lookup error; alone → step-up).
    ip_country_outside: number;
    ip_country_unknown: number;
  };
  // More than `ip_signups_points_over` signups from one IP in 24 h adds points;
  // more than `ip_signups_refuse_over` refuses.
  ip_signups_points_over: number;
  ip_signups_refuse_over: number;
  fast_form_ms: number;
  thresholds: { step_up: number; review: number; refuse: number };
}

export const DEFAULT_PERSONAL_RISK_CONFIG: PersonalRiskConfig = {
  points: {
    robot_low: 40,
    network_hosting: 25,
    ip_signups: 20,
    phone_ip_country_mismatch: 15,
    gmail_alias_of_existing: 30,
    fast_form: 40,
    random_looking: 10,
    phone_reused: 30,
    ip_country_outside: 60,
    ip_country_unknown: 30,
  },
  ip_signups_points_over: 2,
  ip_signups_refuse_over: 5,
  fast_form_ms: 4000,
  thresholds: { step_up: 30, review: 60, refuse: 90 },
};

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** The configured rating (SIGN_PERSONAL_RISK_CONFIG JSON overrides any subset of the defaults). */
export function personalRiskConfig(env: NodeJS.ProcessEnv = process.env): PersonalRiskConfig {
  const raw = env['SIGN_PERSONAL_RISK_CONFIG'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_PERSONAL_RISK_CONFIG;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return DEFAULT_PERSONAL_RISK_CONFIG;
    o = parsed as Record<string, unknown>;
  } catch {
    return DEFAULT_PERSONAL_RISK_CONFIG;
  }
  const d = DEFAULT_PERSONAL_RISK_CONFIG;
  const p = (o['points'] ?? {}) as Record<string, unknown>;
  const t = (o['thresholds'] ?? {}) as Record<string, unknown>;
  const cfg: PersonalRiskConfig = {
    points: {
      robot_low: num(p['robot_low'], d.points.robot_low),
      network_hosting: num(p['network_hosting'], d.points.network_hosting),
      ip_signups: num(p['ip_signups'], d.points.ip_signups),
      phone_ip_country_mismatch: num(p['phone_ip_country_mismatch'], d.points.phone_ip_country_mismatch),
      gmail_alias_of_existing: num(p['gmail_alias_of_existing'], d.points.gmail_alias_of_existing),
      fast_form: num(p['fast_form'], d.points.fast_form),
      random_looking: num(p['random_looking'], d.points.random_looking),
      phone_reused: num(p['phone_reused'], d.points.phone_reused),
      ip_country_outside: num(p['ip_country_outside'], d.points.ip_country_outside),
      ip_country_unknown: num(p['ip_country_unknown'], d.points.ip_country_unknown),
    },
    ip_signups_points_over: num(o['ip_signups_points_over'], d.ip_signups_points_over),
    ip_signups_refuse_over: num(o['ip_signups_refuse_over'], d.ip_signups_refuse_over),
    fast_form_ms: num(o['fast_form_ms'], d.fast_form_ms),
    thresholds: {
      step_up: num(t['step_up'], d.thresholds.step_up),
      review: num(t['review'], d.thresholds.review),
      refuse: num(t['refuse'], d.thresholds.refuse),
    },
  };
  // Thresholds must stay ordered; a mis-ordered override falls back to the defaults.
  const th = cfg.thresholds;
  if (!(th.step_up <= th.review && th.review <= th.refuse)) cfg.thresholds = d.thresholds;
  return cfg;
}

export interface PersonalSignupSignalsInput {
  robot: RobotVerdict;
  network: NetworkKind;
  // Signups from this IP in the last 24 h, INCLUDING this one.
  ip_signups_24h: number;
  phone_region: string | null;
  // null = UNKNOWN (never treated as inside or outside).
  ip_country: string | null;
  // The allowed network countries (SIGN_PERSONAL_ALLOWED_COUNTRIES); omitted = no
  // network-country signal (callers that predate the ruling).
  allowed_countries?: readonly string[];
  gmail_alias_of_existing: boolean;
  elapsed_ms: number | null;
  honeypot_filled: boolean;
  name: string;
  email_local_part: string;
  phone_reused: boolean;
}

export interface PersonalRiskSignal {
  key: string;
  points: number;
  refuse?: true;
  detail?: string;
}

export interface PersonalRiskResult {
  points: number;
  decision: PersonalRiskDecision;
  signals: PersonalRiskSignal[];
}

/** The §6.2 points → decision table. */
export function decisionForPoints(points: number, cfg: PersonalRiskConfig = DEFAULT_PERSONAL_RISK_CONFIG): PersonalRiskDecision {
  if (points >= cfg.thresholds.refuse) return 'refuse';
  if (points >= cfg.thresholds.review) return 'review';
  if (points >= cfg.thresholds.step_up) return 'step_up';
  return 'allow';
}

const VOWELS = /[aeiouy]/i;

/**
 * A small, explainable heuristic for a random-looking name or email local part:
 * a long consonant run, no vowels in a long token, or a long letters+digits mash.
 */
export function looksRandom(value: string): boolean {
  const v = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (v.length < 6) return false;
  if (/[bcdfghjklmnpqrstvwxz]{7,}/.test(v)) return true;
  const letters = v.replace(/[0-9]/g, '');
  if (letters.length >= 6 && !VOWELS.test(letters)) return true;
  const digits = v.length - letters.length;
  return v.length >= 10 && digits >= 4 && letters.length >= 4 && /[a-z][0-9]+[a-z]/.test(v);
}

/** Rate one signup. Pure: the caller gathers the inputs and stores the result. */
export function ratePersonalSignup(input: PersonalSignupSignalsInput, cfg: PersonalRiskConfig = DEFAULT_PERSONAL_RISK_CONFIG): PersonalRiskResult {
  const signals: PersonalRiskSignal[] = [];
  const add = (key: string, points: number, detail?: string) => signals.push({ key, points, ...(detail === undefined ? {} : { detail }) });
  const refuse = (key: string, detail?: string) => signals.push({ key, points: 0, refuse: true, ...(detail === undefined ? {} : { detail }) });

  if (input.honeypot_filled) refuse('honeypot_filled');
  if (input.robot === 'fail') refuse('robot_check_failed');
  else if (input.robot === 'low') add('robot_check_low', cfg.points.robot_low);
  if (input.network === 'hosting' || input.network === 'vpn' || input.network === 'tor') {
    add('network_hosting_vpn_tor', cfg.points.network_hosting, input.network);
  }
  if (input.ip_signups_24h > cfg.ip_signups_refuse_over) refuse('ip_signups_24h', String(input.ip_signups_24h));
  else if (input.ip_signups_24h > cfg.ip_signups_points_over) add('ip_signups_24h', cfg.points.ip_signups, String(input.ip_signups_24h));
  if (input.allowed_countries !== undefined) {
    if (input.ip_country === null) add('ip_country_unknown', cfg.points.ip_country_unknown);
    else if (!input.allowed_countries.includes(input.ip_country.toUpperCase())) {
      add('ip_country_outside', cfg.points.ip_country_outside, input.ip_country.toUpperCase());
    }
  }
  if (input.phone_region !== null && input.ip_country !== null && input.phone_region !== input.ip_country) {
    add('phone_ip_country_mismatch', cfg.points.phone_ip_country_mismatch, `${input.phone_region}/${input.ip_country}`);
  }
  if (input.gmail_alias_of_existing) add('gmail_alias_of_existing', cfg.points.gmail_alias_of_existing);
  if (input.elapsed_ms === null || input.elapsed_ms < cfg.fast_form_ms) {
    add('fast_form', cfg.points.fast_form, input.elapsed_ms === null ? 'missing' : String(input.elapsed_ms));
  }
  if (looksRandom(input.name) || looksRandom(input.email_local_part)) add('random_looking', cfg.points.random_looking);
  if (input.phone_reused) add('phone_reused', cfg.points.phone_reused);

  const points = signals.reduce((s, x) => s + x.points, 0);
  const decision = signals.some((s) => s.refuse === true) ? 'refuse' : decisionForPoints(points, cfg);
  return { points, decision, signals };
}
