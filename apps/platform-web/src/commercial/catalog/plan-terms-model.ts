import type { CatalogVersionTerms } from './catalog-api';

// SIGN-FREE-PARITY-1 S1 / S5 — the pure model behind PlanTermsEditor. The server is the authority for
// every edit (applyCatalogDraftEdits); this only shapes what the console shows.

const ALLOWANCE_LABEL: Readonly<Record<string, string>> = {
  'sign.envelopes': 'Envelopes',
  'sign.forms': 'Forms (not built)',
};

export const FEATURE_LABEL: Readonly<Record<string, string>> = {
  'sign.reports': 'Reports',
  'sign.delegate_signing': 'Delegate signing',
  'sign.access_code': 'Access code',
  'sign.branding': 'Branding',
  'sign.custom_roles': 'Custom roles',
  'sign.whatsapp_delivery': 'WhatsApp delivery',
  'sign.sms_delivery': 'SMS delivery',
  'sign.sms_otp': 'SMS code for signers',
  'sign.email_otp': 'Email code for signers',
  'sign.team_collaboration': 'Team workspace',
  'sign.templates': 'Templates',
};

export interface PlanTermsRows {
  readonly dailyCapPresent: boolean;
  readonly dailyCapText: string;
  readonly allowances: readonly { readonly key: string; readonly label: string; readonly removable: boolean }[];
  readonly features: readonly { readonly key: string; readonly label: string; readonly enabled: boolean }[];
}

export function planTermsRows(t: CatalogVersionTerms): PlanTermsRows {
  const day = t.envelopes_per_day ?? null;
  return {
    dailyCapPresent: day !== null,
    dailyCapText: day === null ? '' : String(day),
    allowances: (t.allowance_keys ?? []).map((key) => ({ key, label: ALLOWANCE_LABEL[key] ?? key, removable: key !== 'sign.envelopes' })),
    features: (t.features ?? []).map((f) => ({ key: f.feature_key, label: FEATURE_LABEL[f.feature_key] ?? f.feature_key, enabled: f.enabled })),
  };
}

/** "" removes the cap (null); otherwise a whole number of 1 or more. */
export function parseDailyCapInput(raw: string): { ok: true; value: number | null } | { ok: false } {
  const s = raw.trim();
  if (s === '') return { ok: true, value: null };
  if (!/^\d+$/.test(s)) return { ok: false };
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 1 ? { ok: true, value: n } : { ok: false };
}

/** The publish option is offered only for a FREE plan with subscribers on older versions. */
export function offersFreeAdoption(t: CatalogVersionTerms): boolean {
  return t.sales_model === 'FREE';
}
