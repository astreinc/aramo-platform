import { useEffect, useState } from 'react';
import { apiClient } from '@aramo/fe-foundation';

import { errorMessage } from '../api';
import { US_STATES, toOrganizationPayload, validateOrgDetails, type FieldErrors, type OrgDetailsValues, type OrganizationPayload } from '../routes/organization-details';
import { Btn, Check, ErrorBox, Field, Sel, TextIn } from '../ui';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §5 — Settings → Upgrade to
// Business. The owner of a Personal account turns it into a Business organization in
// place: the same account keeps its documents, their evidence and storage, and its
// retention setting. Dark: the backend answers 404 unless SIGN_PERSONAL_UPGRADE_ENABLED=1,
// and then this card renders nothing. Shown only when the backend says the account may
// upgrade (a couple of refusals are explained instead). Typing UPGRADE confirms; the
// upgrade cannot be undone. Afterwards the workspace reloads on Billing so the owner can
// choose a Business plan.

export interface UpgradeStatus {
  eligible: boolean;
  reason: string | null;
  current_name: string;
  terms: { key: string; version: string; url: string } | null;
  subscription: { plan_key: string; source: string } | null;
}

export interface UpgradeRequest {
  confirm: 'UPGRADE';
  organization_name: string;
  organization: OrganizationPayload;
  accept_terms: true;
}

export const upgradeApi = {
  status: () => apiClient.get<UpgradeStatus>('/v1/sign/account/upgrade'),
  upgrade: (body: UpgradeRequest) =>
    apiClient.post<{ state: 'upgraded'; kind: 'BUSINESS'; organization_name: string; upgraded_at: string }>('/v1/sign/account/upgrade', body),
};

export const AFTER_UPGRADE_PATH = '/sign/settings/billing';

// Refusals the owner can act on are explained; every other one hides the card.
const EXPLAINED: Record<string, string> = {
  personal_account_not_in_good_standing: 'Your account can’t be upgraded while it is under review or sending is paused.',
  personal_paid_subscription_upgrade_unsupported: 'Accounts on a paid Personal plan can’t be upgraded here yet. Contact Aramo to move to a Business plan.',
};

const EMPTY: OrgDetailsValues = {
  legal_name: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state_province: '',
  postal_code: '',
  primary_contact_email: '',
  primary_contact_name: '',
  signer_title: '',
  primary_contact_phone: '',
  tax_id: '',
  registration_number: '',
};

const TEXT_FIELDS: ReadonlyArray<readonly [keyof OrgDetailsValues, string, boolean]> = [
  ['legal_name', 'Legal name', true],
  ['address_line1', 'Street address', true],
  ['address_line2', 'Address line 2 (optional)', false],
  ['city', 'City', true],
  ['postal_code', 'ZIP code', true],
  ['primary_contact_email', 'Billing contact email', true],
  ['primary_contact_name', 'Your full name', true],
  ['signer_title', 'Your title', true],
  ['primary_contact_phone', 'Phone (optional)', false],
  ['tax_id', 'EIN (optional)', false],
  ['registration_number', 'Registration number (optional)', false],
];

function useUpgradeStatus(loader: () => Promise<UpgradeStatus>): UpgradeStatus | null {
  const [status, setStatus] = useState<UpgradeStatus | null>(null);
  // Loaded once per mount; a 404 (switched off) or any error leaves the card hidden.
  useEffect(() => {
    let live = true;
    loader()
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, []);
  return status;
}

export function UpgradeToBusinessSection({
  loader = upgradeApi.status,
  upgrader = upgradeApi.upgrade,
  onUpgraded = () => window.location.assign(AFTER_UPGRADE_PATH),
}: {
  loader?: () => Promise<UpgradeStatus>;
  upgrader?: (body: UpgradeRequest) => Promise<unknown>;
  onUpgraded?: () => void;
} = {}) {
  const status = useUpgradeStatus(loader);
  const [orgName, setOrgName] = useState('');
  const [values, setValues] = useState<OrgDetailsValues>(EMPTY);
  const [attested, setAttested] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [typed, setTyped] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (status === null) return null;
  if (!status.eligible) {
    const why = status.reason !== null ? EXPLAINED[status.reason] : undefined;
    if (why === undefined) return null;
    return (
      <section className="sg-card" data-testid="settings-upgrade-business">
        <div className="sg-card__head">Upgrade to Business</div>
        <div className="sg-card__body">
          <p style={{ margin: 0 }} data-testid="upgrade-unavailable">
            {why}
          </p>
        </div>
      </section>
    );
  }
  const terms = status.terms!;
  const set = (k: keyof OrgDetailsValues) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [k]: e.target.value }));
  const submit = async () => {
    const found = validateOrgDetails(values, attested);
    const name = orgName.replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 100) found.organization_name = 'Enter an organization name (2–100 characters).';
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      await upgrader({ confirm: 'UPGRADE', organization_name: name, organization: toOrganizationPayload(values), accept_terms: true });
      onUpgraded();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <section className="sg-card" data-testid="settings-upgrade-business">
      <div className="sg-card__head">Upgrade to Business</div>
      <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
        <div>
          <p style={{ margin: '0 0 8px' }}>Turn this personal account into a business organization on Aramo Sign:</p>
          <ul style={{ margin: 0, paddingLeft: 20 }} data-testid="upgrade-consequences">
            <li>your documents, their signing evidence and your retention setting stay exactly as they are;</li>
            <li>your Free personal plan ends. Choose a Business plan on the Billing page to keep sending;</li>
            <li>you become the organization’s owner and administrator and can invite people;</li>
            <li>the organization is held to the United States, and you keep signing in with your Google account;</li>
            <li>
              <strong>this can’t be undone.</strong> The account can’t go back to a personal account.
            </li>
          </ul>
        </div>
        <Field label="Organization name" htmlFor="upgrade-org-name" error={errors.organization_name}>
          <TextIn id="upgrade-org-name" maxLength={100} value={orgName} onChange={(e) => setOrgName(e.target.value)} disabled={busy} />
        </Field>
        {TEXT_FIELDS.map(([key, label]) => (
          <Field key={key} label={label} htmlFor={`upgrade-${key}`} error={errors[key]}>
            <TextIn id={`upgrade-${key}`} value={values[key]} onChange={set(key)} disabled={busy} />
          </Field>
        ))}
        <Field label="State" htmlFor="upgrade-state_province" error={errors.state_province}>
          <Sel id="upgrade-state_province" value={values.state_province} onChange={set('state_province')} disabled={busy}>
            <option value="">Choose a state</option>
            {US_STATES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </Sel>
        </Field>
        <label className="sg-check">
          <Check checked={attested} onChange={(e) => setAttested(e.target.checked)} disabled={busy} aria-label="I am authorized to act for this organization" />
          <span>I am authorized to act for this organization and to accept the Aramo terms on its behalf.</span>
        </label>
        {errors.authority_attested !== undefined ? <ErrorBox>{errors.authority_attested}</ErrorBox> : null}
        <label className="sg-check">
          <Check checked={accepted} onChange={(e) => setAccepted(e.target.checked)} disabled={busy} aria-label="I accept the business terms" />
          <span>
            I accept the{' '}
            <a href={terms.url} target="_blank" rel="noopener noreferrer">
              Aramo Sign Terms of Service
            </a>{' '}
            (version {terms.version}) for the organization.
          </span>
        </label>
        <Field label="Type UPGRADE to confirm" htmlFor="upgrade-confirm">
          <TextIn id="upgrade-confirm" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} />
        </Field>
        {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
        <div>
          <Btn variant="primary" disabled={busy || typed !== 'UPGRADE' || !accepted} onClick={() => void submit()}>
            {busy ? 'Upgrading…' : 'Upgrade to Business'}
          </Btn>
        </div>
      </div>
    </section>
  );
}
