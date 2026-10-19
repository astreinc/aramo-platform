import { useEffect, useState } from 'react';
import { NavLink, Navigate, useParams } from 'react-router-dom';
import { logout } from '@aramo/fe-foundation';

import { errorMessage, senderApi, type SignMember, type SignRoleKey } from '../api';
import { Btn, Check, Field, Icon, LinkBtn, Sel, TextIn } from '../ui';
import { useWorkspace } from '../workspace';

import { BillingPanel } from './Billing';

// Sign Settings (change log §B): Personal (Shared · read-only vs Sign-only),
// Branding, Signing security, Integrations, Envelope audit, and the two links out
// to Organization administration (the single shared authority for the tenant
// profile and users), and (Aramo Sign launch) Plan & billing. Nothing here pretends to persist: Sign-only notification
// and branding storage do not exist yet, so those controls ship as labelled seams.

const SECTIONS = [
  { key: 'personal', label: 'Personal' },
  { key: 'billing', label: 'Plan & billing' },
  { key: 'members', label: 'Members' },
  { key: 'branding', label: 'Branding' },
  { key: 'security', label: 'Signing security' },
  { key: 'integrations', label: 'Integrations' },
  { key: 'audit', label: 'Envelope audit' },
] as const;

export function SettingsPage() {
  const { section = 'personal' } = useParams();
  const { base, ctx } = useWorkspace();
  const personalWs = ctx.workspace === 'personal';
  // Sign Unified Product S-1 — Members only for holders of esign:member:manage.
  const allowed = personalWs
    ? ['personal']
    : SECTIONS.map((s) => s.key).filter((k) => k !== 'members' || ctx.permissions.members === true);
  if (!allowed.includes(section)) return <Navigate to={`${base}/settings/personal`} replace />;
  const org = ctx.organization_url;
  return (
    <div className="sg-page sg-page--wide">
      <h1 className="sg-h1" style={{ marginBottom: 18 }}>
        Settings
      </h1>
      <div className="sg-settings">
        <nav className="sg-setnav" aria-label="Settings sections">
          {SECTIONS.filter((s) => allowed.includes(s.key)).map((s) => (
            <NavLink key={s.key} to={`${base}/settings/${s.key}`} className={({ isActive }) => (isActive ? 'sg-setnav--on' : '')}>
              {s.label}
            </NavLink>
          ))}
          {!personalWs && org !== null ? (
            <>
              <a href={org} target="_blank" rel="noopener noreferrer" data-testid="settings-org-profile">
                Organization profile <Icon name="ext" size={12} />
              </a>
              <a href={org.replace(/\/profile$/, '/users')} target="_blank" rel="noopener noreferrer" data-testid="settings-org-users">
                Users &amp; roles <Icon name="ext" size={12} />
              </a>
            </>
          ) : null}
        </nav>
        <div className="sg-grid">
          {section === 'personal' ? <PersonalSection /> : null}
          {section === 'billing' ? <BillingPanel /> : null}
          {section === 'members' ? <MembersSection /> : null}
          {section === 'branding' ? <BrandingSection /> : null}
          {section === 'security' ? <SecuritySection /> : null}
          {section === 'integrations' ? <IntegrationsSection /> : null}
          {section === 'audit' ? <AuditSection /> : null}
        </div>
      </div>
    </div>
  );
}

function PersonalSection() {
  const { ctx } = useWorkspace();
  const prefs = [
    'Email me when a recipient signs',
    'Email me when an envelope completes',
    'Daily digest of outstanding envelopes',
    'Email me when a recipient declines',
  ];
  return (
    <>
      <section className="sg-card" data-testid="settings-account">
        <div className="sg-card__head">
          Your Aramo account <span className="sg-tag sg-tag--grey">Shared · read-only here</span>
          {ctx.app_home_url !== null ? (
            <a className="sg-card__end sg-btn sg-btn--sm" href={`${ctx.app_home_url}preferences`}>
              Manage in Aramo account <span className="sg-tag sg-tag--dark">App Home</span>
            </a>
          ) : null}
        </div>
        <div className="sg-card__body">
          <div className="sg-kv">
            <div>
              <div className="sg-kv__k">Name</div>
              <div className="sg-kv__v">{ctx.user.display_name ?? '—'}</div>
            </div>
            <div>
              <div className="sg-kv__k">Email</div>
              <div className="sg-kv__v">{ctx.user.email ?? '—'}</div>
            </div>
            <div>
              <div className="sg-kv__k">Organization</div>
              <div className="sg-kv__v">{ctx.tenant.name}</div>
            </div>
            <div>
              <div className="sg-kv__k">Account type</div>
              <div className="sg-kv__v">{ctx.tenant.kind === 'PERSONAL' ? 'Personal' : 'Business'}</div>
            </div>
          </div>
          <p className="sg-help" style={{ marginTop: 12 }}>
            Your name, email, password and sign-in method belong to your shared Aramo account and are the same in every Aramo app.
          </p>
        </div>
      </section>
      <section className="sg-card">
        <div className="sg-card__head">
          Sign notifications <span className="sg-tag sg-tag--blue">Sign only</span>
          <span className="sg-card__end sg-tag sg-tag--warn">Coming soon</span>
        </div>
        <div className="sg-card__body">
          {prefs.map((p) => (
            <label key={p} className="sg-settings-row">
              <Check disabled checked={false} onChange={() => undefined} />
              <span className="sg-faint">{p}</span>
            </label>
          ))}
          <p className="sg-help">Saving Sign notification preferences needs a Sign settings store, which isn’t available yet. Nothing here is saved.</p>
        </div>
      </section>
      <section className="sg-card">
        <div className="sg-card__body">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Session</div>
          <span className="sg-muted">Signed in through Aramo Identity. </span>
          <LinkBtn onClick={() => void logout()}>Sign out</LinkBtn>
        </div>
      </section>
    </>
  );
}

function BrandingSection() {
  const { ctx } = useWorkspace();
  return (
    <div className="sg-grid sg-grid--2" style={{ alignItems: 'start' }}>
      <section className="sg-card">
        <div className="sg-card__head">
          Branding <span className="sg-card__end sg-tag sg-tag--warn">Proposed</span>
        </div>
        <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
          <Field label="Organization name shown to recipients" htmlFor="b-name">
            <TextIn id="b-name" value={ctx.tenant.name} disabled readOnly />
          </Field>
          <Field label="Accent color" htmlFor="b-accent">
            <Sel id="b-accent" disabled value="blue" onChange={() => undefined}>
              <option value="blue">Aramo blue</option>
            </Sel>
          </Field>
          <Field label="Button style" htmlFor="b-btn">
            <Sel id="b-btn" disabled value="rounded" onChange={() => undefined}>
              <option value="rounded">Rounded</option>
            </Sel>
          </Field>
          <p className="sg-help">
            Custom signing branding is a proposed capability: there is no Sign branding store yet, so recipients see the Aramo Sign brand.
          </p>
        </div>
      </section>
      <section className="sg-card">
        <div className="sg-card__head">Organization profile</div>
        <div className="sg-card__body">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="sg-brand__mark">{ctx.tenant.name.charAt(0).toUpperCase()}</span>
            <strong>{ctx.tenant.name}</strong>
          </div>
          <p className="sg-help">The organization name and logo come from Organization administration, shared by every Aramo app.</p>
          {ctx.organization_url !== null ? (
            <a className="sg-btn sg-btn--sm" href={ctx.organization_url} target="_blank" rel="noopener noreferrer">
              Open organization profile <Icon name="ext" size={12} />
            </a>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function SecuritySection() {
  return (
    <>
      <section className="sg-card">
        <div className="sg-card__head">Recipient verification</div>
        <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
          <div className="sg-grid sg-grid--2">
            <Field label="Default for new recipients" htmlFor="s-auth">
              <Sel id="s-auth" value="LINK" onChange={() => undefined}>
                <option value="LINK">Secure link</option>
                <option value="OTP" disabled>
                  Link + passcode (proposal)
                </option>
                <option value="SSO" disabled>
                  SSO verified (proposal)
                </option>
              </Sel>
            </Field>
            <Field label="Link validity" htmlFor="s-days">
              <Sel id="s-days" value="7" disabled onChange={() => undefined}>
                <option value="7">7 days</option>
              </Sel>
            </Field>
          </div>
          <div className="sg-note">
            <span className="sg-tag sg-tag--warn">Design proposal</span>
            <span>
              Secure link is the current capability-link model. One-time passcode and federated SSO verification are design proposals, not approved backend
              functionality.
            </span>
          </div>
        </div>
      </section>
      <section className="sg-card">
        <div className="sg-card__body">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Sender access</div>
          <span className="sg-muted">
            Sender and admin sign-in is handled by Aramo Identity, including any single sign-on with your organization’s identity provider. MFA, session length and
            password policy are configured there, not in Aramo Sign.
          </span>
        </div>
      </section>
      <section className="sg-card">
        <div className="sg-card__head">
          Retention <span className="sg-card__end sg-tag sg-tag--warn">Concept</span>
        </div>
        <div className="sg-card__body sg-grid sg-grid--2">
          <Field label="Completed documents" htmlFor="r-docs">
            <Sel id="r-docs" disabled value="forever" onChange={() => undefined}>
              <option value="forever">Retain indefinitely</option>
            </Sel>
          </Field>
          <Field label="Audit records" htmlFor="r-audit">
            <Sel id="r-audit" disabled value="with" onChange={() => undefined}>
              <option value="with">Retain with document</option>
            </Sel>
          </Field>
          <p className="sg-help">Design proposal — not established in the backend contract.</p>
        </div>
      </section>
    </>
  );
}

function IntegrationsSection() {
  const { ctx } = useWorkspace();
  const cards: { name: string; tag: [string, string]; text: string; action?: { label: string; href?: string } }[] = [
    {
      name: 'Aramo ATS',
      tag: ['Existing · domain', 'ok'],
      text: 'ATS recruiting flows (Right to Represent, offer letters) already use the shared E-Sign engine. Surfacing those envelopes in this console is proposed.',
      ...(ctx.app_home_url !== null ? { action: { label: 'Open Aramo ATS', href: `${ctx.app_home_url}ats/` } } : {}),
    },
    { name: 'Microsoft 365', tag: ['Conceptual', 'grey'], text: 'Send envelopes from Outlook; completed documents to SharePoint.' },
    { name: 'Google Workspace', tag: ['Conceptual', 'grey'], text: 'Start envelopes from Drive; completed documents back to Drive.' },
    { name: 'Salesforce', tag: ['Conceptual', 'grey'], text: 'Send from an opportunity; status on the record.' },
    { name: 'REST API', tag: ['Conceptual', 'grey'], text: 'Envelopes API and embedded signing.' },
    { name: 'Webhooks', tag: ['Not configured', 'warn'], text: 'Envelope and recipient events to your endpoint.' },
    { name: 'Identity providers', tag: ['Existing · auth-service', 'ok'], text: 'Aramo’s shared auth-service signs senders in to this console.' },
  ];
  return (
    <div className="sg-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
      {cards.map((c) => (
        <section key={c.name} className="sg-card" data-testid="integration-card">
          <div className="sg-card__body" style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>{c.name}</strong>
              <span className={`sg-tag sg-tag--${c.tag[1]}`} style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }}>
                {c.tag[0]}
              </span>
            </div>
            <div className="sg-muted" style={{ flex: 1 }}>
              {c.text}
            </div>
            {c.action?.href !== undefined ? (
              <a className="sg-btn sg-btn--sm" style={{ alignSelf: 'flex-start' }} href={c.action.href}>
                {c.action.label}
              </a>
            ) : (
              <Btn size="sm" disabled style={{ alignSelf: 'flex-start' }}>
                Not available
              </Btn>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}

function AuditSection() {
  const { base } = useWorkspace();
  return (
    <section className="sg-card">
      <div className="sg-card__head">Administrative audit</div>
      <div className="sg-empty">
        <div className="sg-empty__t">No Sign settings changes recorded</div>
        Sign settings can’t be changed yet, so there is nothing to audit here. Every envelope keeps its own tamper-evident activity:{' '}
        <NavLink to={`${base}/activity`}>see all envelope activity</NavLink>.
      </div>
    </section>
  );
}

// Sign Unified Product S-1 — Sign member administration. Lists the organization's
// members with their Sign role; a holder of esign:member:manage assigns or removes
// it. Only a Sign Owner can grant or remove Owner, and the last Owner stays — the
// backend enforces both and its message is shown as is.
function MembersSection() {
  const { ctx, toast } = useWorkspace();
  const [rows, setRows] = useState<SignMember[] | null>(null);
  const [roles, setRoles] = useState<{ key: SignRoleKey; display: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    senderApi
      .members()
      .then((r) => {
        if (!live) return;
        setRows(r.items);
        setRoles(r.roles);
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, []);

  const change = async (m: SignMember, value: string) => {
    setBusy(m.user_id);
    try {
      const next = value === '' ? null : (value as SignRoleKey);
      const updated = await senderApi.setMemberRole(m.user_id, next);
      setRows((cur) => (cur ?? []).map((r) => (r.user_id === updated.user_id ? updated : r)));
      toast(next === null ? `Removed Sign access for ${m.display_name ?? m.email}` : `${m.display_name ?? m.email} is now ${updated.sign_role_display ?? 'updated'}`);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="sg-card" data-testid="settings-members">
      <div className="sg-card__head">Members</div>
      <div className="sg-card__body">
        <p className="sg-help" style={{ marginBottom: 12 }}>
          Sign roles decide what each person can do in Aramo Sign. Senders work with their own envelopes; Viewers see every envelope in the organization; Admins
          manage members and every envelope; Owners also manage the plan.
        </p>
        {error !== null ? <div className="sg-note">{error}</div> : null}
        {rows === null && error === null ? <div className="sg-muted">Loading…</div> : null}
        {rows !== null ? (
          <table className="sg-table" data-testid="members-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Sign role</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.user_id}>
                  <td>
                    {m.display_name ?? '—'}
                    {m.user_id === ctx.user.id ? <span className="sg-tag sg-tag--grey" style={{ marginLeft: 6 }}>You</span> : null}
                    {!m.active ? <span className="sg-tag sg-tag--warn" style={{ marginLeft: 6 }}>Inactive</span> : null}
                  </td>
                  <td>{m.email}</td>
                  <td>
                    <Sel
                      aria-label={`Sign role for ${m.display_name ?? m.email}`}
                      value={m.sign_role ?? ''}
                      disabled={busy !== null || !m.active}
                      onChange={(e) => void change(m, e.target.value)}
                    >
                      <option value="">No Sign access</option>
                      {roles.map((r) => (
                        <option key={r.key} value={r.key}>
                          {r.display}
                        </option>
                      ))}
                    </Sel>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  );
}
