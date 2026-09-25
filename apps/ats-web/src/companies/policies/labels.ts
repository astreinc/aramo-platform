import type { PolicyDomain } from './CompanyPoliciesOverview';

// CSP PA-3 — shared human labels + setting text for the policy surfaces, so the
// overview, the effective preview, and (later) the editors render one vocabulary.

export const SUBMITTAL_LABELS: Record<string, string> = {
  resume_selected: 'Résumé selected',
  engagement_satisfied: 'Engagement satisfied',
  work_authorization_present: 'Work authorization',
  bill_rate_present: 'Bill rate',
  rtr_present: 'Right to Represent',
};

export function submittalLabel(key: string): string {
  return SUBMITTAL_LABELS[key] ?? key;
}
export function engagementLabel(channel: 'voice' | 'email'): string {
  return channel === 'voice' ? 'Voice engagement' : 'Email engagement';
}
export function dispositionSetting(disposition: 'REQUIRED' | 'NOT_REQUIRED'): string {
  return disposition === 'REQUIRED' ? 'Required' : 'Not required';
}
export function requiredSetting(required: boolean): string {
  return required ? 'Required' : 'Not required';
}
export function blockingSetting(blocking: boolean): string {
  return blocking ? 'Blocking' : 'Non-blocking';
}

export const DOMAIN_TITLES: Record<PolicyDomain, string> = {
  engagement: 'Engagement Policy',
  'client-submittal': 'Client Submittal Policy',
  'pre-start': 'Pre-Start Policy',
};
