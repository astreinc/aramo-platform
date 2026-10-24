import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Checkbox, Input, hasScope, useToast, type Session } from '@aramo/fe-foundation';

import { PLATFORM_PERMISSIONS as P, Stepper } from '../components';
import { platformApi, PERSONAL_TENANT_CAPABILITIES, type TenantKind } from '../platform-api';
import { PlatformAccessDenied } from '../shell/PlatformAccessDenied';

import { capabilityLabel } from './tenant-labels';
import {
  EMAIL_PATTERN,
  SLUG_PATTERN,
  provisionErrorCopy,
  slugify,
  type ErrorCopy,
  type ProvisionField,
} from './tenant-errors';
import { WithSession } from './with-session';

import './tenants.css';

// PLATFORM-UX-1 F-4 (handoff §6.2) — Provision tenant in three steps
// (Organization & owner → Capabilities → Review) with the sticky "What will
// happen" card. Nothing is created until the last step's Provision tenant.
// The page itself needs platform:tenant:provision; without it the in-shell
// access-denied state renders (directive R-5). The backend DTO and service stay
// authoritative (closed kinds, the Personal capability set, the slug gate).

export const PROVISION_STEPS = ['Organization & owner', 'Capabilities', 'Review'] as const;

/** The design's capability cards (CAPS). `sourcing` is reserved: never selectable. */
export const CAPABILITY_CARDS: readonly { readonly key: string; readonly description: string }[] = [
  { key: 'core', description: 'Organization, users and sign-in. Always on.' },
  { key: 'ats', description: 'Requisitions, talent and interviews.' },
  { key: 'portal', description: 'Talent-facing portal.' },
  { key: 'sourcing', description: 'Reserved. Not yet available.' },
  { key: 'sign', description: 'Aramo Sign e-signature.' },
  { key: 'intelligence', description: 'Skills-based matching.' },
];

const DEFAULT_CAPS = ['core', 'ats', 'portal'];

export interface ProvisionDraft {
  readonly name: string;
  readonly kind: TenantKind;
  readonly email: string;
  readonly display: string;
  readonly slug: string;
  readonly caps: readonly string[];
  readonly send: boolean;
}

/** Step-1 validation (handoff §6.2): name ≥ 2, a valid email, an optional slug matching the rule. */
export function validateStep1(d: ProvisionDraft): Partial<Record<ProvisionField, string>> {
  const errs: Partial<Record<ProvisionField, string>> = {};
  if (d.name.trim().length < 2) errs.name = 'Enter at least 2 characters.';
  if (!EMAIL_PATTERN.test(d.email.trim())) errs.email = 'Enter a valid email address.';
  if (d.slug !== '' && !SLUG_PATTERN.test(d.slug)) errs.slug = 'Use lowercase letters, numbers and hyphens.';
  return errs;
}

/** The capabilities that will be sent: Personal is fixed to Core + Sign. */
export function effectiveCapabilities(d: ProvisionDraft): string[] {
  if (d.kind === 'PERSONAL') return [...PERSONAL_TENANT_CAPABILITIES];
  return CAPABILITY_CARDS.map((c) => c.key).filter((k) => k !== 'sourcing' && (k === 'core' || d.caps.includes(k)));
}

/** The slug that will be sent: the typed one, else the one generated from the name. */
export function effectiveSlug(d: ProvisionDraft): string {
  return d.slug !== '' ? d.slug : slugify(d.name.trim());
}

export function ProvisionTenantView({ session }: { readonly session?: Session } = {}) {
  return (
    <WithSession session={session}>
      {(s) =>
        hasScope(s, P.tenantProvision) ? (
          <ProvisionTenant />
        ) : (
          <PlatformAccessDenied session={s} scope={P.tenantProvision} page="Provision tenant" />
        )
      }
    </WithSession>
  );
}

function ProvisionTenant() {
  const navigate = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [draft, setDraft] = useState<ProvisionDraft>({
    name: '',
    kind: 'BUSINESS',
    email: '',
    display: '',
    slug: '',
    caps: DEFAULT_CAPS,
    send: true,
  });
  const [touched, setTouched] = useState(false);
  const [formError, setFormError] = useState<ErrorCopy | null>(null);
  const [serverField, setServerField] = useState<Partial<Record<ProvisionField, string>>>({});
  const [busy, setBusy] = useState(false);

  const edit = (patch: Partial<ProvisionDraft>): void => {
    setDraft((d) => ({ ...d, ...patch }));
    setFormError(null);
    setServerField({});
  };

  const local = validateStep1(draft);
  const errs: Partial<Record<ProvisionField, string>> = {
    name: touched ? local.name : undefined,
    email: touched ? local.email : undefined,
    slug: local.slug,
    ...serverField,
  };
  const personal = draft.kind === 'PERSONAL';
  const nameV = draft.name.trim() || '—';
  const host = `${effectiveSlug(draft) || 'your-slug'}.aramo.ai`;
  const caps = effectiveCapabilities(draft);

  const next1 = (): void => {
    if (Object.keys(local).length > 0) {
      setTouched(true);
      return;
    }
    setStep(2);
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setFormError(null);
    try {
      const name = draft.name.trim();
      const slug = effectiveSlug(draft);
      const res = await platformApi.provisionTenant({
        name,
        owner_email: draft.email.trim(),
        owner_display_name: draft.display.trim() || undefined,
        capabilities: caps,
        invite_owner: draft.send,
        kind: draft.kind,
        slug: slug === '' ? undefined : slug,
      });
      toast.show(`${name} provisioned${res.invitation_sent ? ' · owner invite sent.' : '.'}`);
      navigate(`/tenants/${res.tenant_id}?tab=overview`);
    } catch (e) {
      const copy = provisionErrorCopy(e);
      if (copy.kind === 'field') {
        setServerField({ [copy.field]: copy.message });
        setTouched(true);
        setStep(1);
      } else {
        setFormError({ message: copy.message, code: copy.code });
        setStep(copy.step);
      }
      setBusy(false);
    }
  };

  return (
    <div className="pw-page">
      <div className="pt-head--block">
        <h1 className="pt-h1">Provision tenant</h1>
        <p className="pt-intro">
          Create a client organization and invite its owner. Nothing is created until you confirm on the last step.
        </p>
      </div>
      <div className="pt-stepper-wrap">
        <Stepper steps={PROVISION_STEPS} current={step} />
      </div>
      <div className="pt-prov">
        <section className="pt-prov__form" aria-label={`Step ${step} of 3: ${PROVISION_STEPS[step - 1]}`}>
          {formError ? (
            <div role="alert" className="pw-alert pw-alert--error pt-prov__error">
              {formError.message} <span className="pt-err-code">{formError.code}</span>
            </div>
          ) : null}

          {step === 1 ? (
            <>
              <div className="pt-grid16">
                <TextField
                  label="Tenant name"
                  required
                  value={draft.name}
                  placeholder="e.g. Halvorsen Clinics"
                  error={errs.name}
                  onChange={(v) => edit({ name: v })}
                />
                <div className="pt-label">
                  <span className="pt-label__text" id="pt-kind-label">
                    Kind
                  </span>
                  <div role="radiogroup" aria-labelledby="pt-kind-label" className="pt-cards">
                    <KindCard
                      on={!personal}
                      title="Business"
                      description="A company or team. Any capability set; users invited by the owner."
                      onSelect={() => edit({ kind: 'BUSINESS' })}
                    />
                    <KindCard
                      on={personal}
                      title="Personal"
                      description="One person using Sign. Capabilities are fixed to Core and Sign."
                      onSelect={() => edit({ kind: 'PERSONAL' })}
                    />
                  </div>
                </div>
                <div className="pt-two">
                  <TextField
                    label="Owner email"
                    required
                    type="email"
                    value={draft.email}
                    placeholder="owner@company.com"
                    error={errs.email}
                    onChange={(v) => edit({ email: v })}
                  />
                  <TextField
                    label="Owner display name"
                    optional
                    value={draft.display}
                    onChange={(v) => edit({ display: v })}
                  />
                </div>
                <label className="pt-label">
                  <span className="pt-label__text">
                    Slug <span className="pt-label__opt">(optional)</span>
                  </span>
                  <span className="pt-slug">
                    <Input
                      unstyled
                      className="pt-slug__input"
                      value={draft.slug}
                      placeholder="generated from the name"
                      aria-invalid={errs.slug ? true : undefined}
                      aria-describedby="pt-slug-host"
                      onChange={(e) => edit({ slug: e.target.value.toLowerCase() })}
                    />
                    <span className="pt-slug__tld" aria-hidden="true">
                      .aramo.ai
                    </span>
                  </span>
                  <span className="pt-field-help" id="pt-slug-host">
                    Sign-in address: <span className="pt-host">{host}</span>
                  </span>
                  {errs.slug ? <span className="pt-field-err">{errs.slug}</span> : null}
                </label>
              </div>
              <div className="pt-actions-end">
                <Button unstyled className="pw-btn pw-btn--secondary" onClick={() => navigate('/tenants')}>
                  Cancel
                </Button>
                <Button unstyled className="pw-btn pw-btn--normal" onClick={next1}>
                  Continue
                </Button>
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <h2 className="pt-step-title">Capabilities</h2>
              <p className="pt-step-sub">Default is Core, ATS and Portal.</p>
              {personal ? (
                <div className="pt-lock">
                  <span aria-hidden="true">🔒</span>
                  <span>
                    Personal tenants always get <b>Core + Sign</b>. Other capabilities need a Business tenant.
                  </span>
                </div>
              ) : null}
              <div className="pt-cards">
                {CAPABILITY_CARDS.map((c) => {
                  const locked = c.key === 'core' || c.key === 'sourcing' || personal;
                  const on = caps.includes(c.key);
                  const lockNote = c.key === 'core' ? 'Always on' : c.key === 'sourcing' ? 'Reserved' : personal ? 'Set by Personal' : '';
                  return (
                    <label key={c.key} className={locked && !on ? 'pt-cap pt-cap--dim' : 'pt-cap'}>
                      <Checkbox
                        unstyled
                        className="pt-check"
                        checked={on}
                        disabled={locked}
                        onChange={() =>
                          edit({ caps: draft.caps.includes(c.key) ? draft.caps.filter((k) => k !== c.key) : [...draft.caps, c.key] })
                        }
                      />
                      <span className="pt-cap__body">
                        <span className="pt-cap__title">
                          {capabilityLabel(c.key)} <span className="pt-cap__key">{c.key}</span>
                        </span>
                        <span className="pt-cap__desc">{c.description}</span>
                        {locked ? <span className="pt-cap__lock">{lockNote}</span> : null}
                      </span>
                    </label>
                  );
                })}
              </div>
              <label className="pt-send">
                <Checkbox
                  unstyled
                  className="pt-check pt-check--flush"
                  checked={draft.send}
                  onChange={(e) => edit({ send: e.target.checked })}
                />
                Send owner invitation now
              </label>
              <div className="pt-actions-end">
                <Button unstyled className="pw-btn pw-btn--secondary" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button unstyled className="pw-btn pw-btn--normal" onClick={() => setStep(3)}>
                  Review
                </Button>
              </div>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <h2 className="pt-step-title pt-step-title--14">Review and provision</h2>
              <dl className="pt-dl">
                <dt>Tenant</dt>
                <dd className="pt-strong">{nameV}</dd>
                <dt>Kind</dt>
                <dd>{personal ? 'Personal' : 'Business'}</dd>
                <dt>Sign-in address</dt>
                <dd className="pt-dl__mono">{host}</dd>
                <dt>Owner</dt>
                <dd>
                  {draft.display.trim() || 'Not set'} · <span className="pt-dl__mono">{draft.email.trim() || '—'}</span>
                </dd>
                <dt>Capabilities</dt>
                <dd>{caps.map(capabilityLabel).join(', ')}</dd>
              </dl>
              <div className="pt-actions-end pt-actions-end--flush">
                <Button unstyled className="pw-btn pw-btn--secondary" disabled={busy} onClick={() => setStep(2)}>
                  Back
                </Button>
                <Button
                  unstyled
                  className="pw-btn pw-btn--privileged"
                  disabled={busy}
                  aria-busy={busy || undefined}
                  onClick={() => void submit()}
                >
                  Provision tenant
                </Button>
              </div>
            </>
          ) : null}
        </section>
        <aside className="pt-prov__aside" aria-labelledby="pt-what-title">
          <h2 id="pt-what-title" className="pt-prov__aside-title">
            What will happen
          </h2>
          <ol className="pt-prov__steps">
            <li>
              <b>{nameV}</b> is created as <b>Provisioned</b>.
            </li>
            <li>
              {draft.send
                ? 'The owner gets an invitation email now.'
                : 'No invitation is sent. You can send it later from the tenant page.'}
            </li>
            <li>
              It becomes <b>Active</b> automatically when the owner first signs in.
            </li>
          </ol>
        </aside>
      </div>
    </div>
  );
}

function KindCard({
  on,
  title,
  description,
  onSelect,
}: {
  readonly on: boolean;
  readonly title: string;
  readonly description: string;
  readonly onSelect: () => void;
}) {
  return (
    <Button unstyled role="radio" aria-checked={on} className={on ? 'pt-radio pt-radio--on' : 'pt-radio'} onClick={onSelect}>
      <span className="pt-radio__title">
        <span aria-hidden="true">{on ? '●' : '○'}</span> {title}
      </span>
      <span className="pt-radio__desc">{description}</span>
    </Button>
  );
}

function TextField({
  label,
  value,
  onChange,
  required = false,
  optional = false,
  type = 'text',
  placeholder,
  error,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly required?: boolean;
  readonly optional?: boolean;
  readonly type?: 'text' | 'email';
  readonly placeholder?: string;
  readonly error?: string;
}) {
  return (
    <label className="pt-label">
      <span className="pt-label__text">
        {label}
        {required ? (
          <>
            {' '}
            <span className="pw-field__req" aria-hidden="true">
              *
            </span>
          </>
        ) : null}
        {optional ? (
          <>
            {' '}
            <span className="pt-label__opt">(optional)</span>
          </>
        ) : null}
      </span>
      <Input
        unstyled
        type={type}
        className="pw-input"
        value={value}
        placeholder={placeholder}
        required={required}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? <span className="pt-field-err">{error}</span> : null}
    </label>
  );
}
