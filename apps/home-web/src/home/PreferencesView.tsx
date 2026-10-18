import {
  IconDesk,
  SettingsSeam,
  productByKey,
  useMyProducts,
} from '@aramo/fe-foundation';
import { useMe } from '@aramo/org-admin-web';

// My preferences (accepted App Home handoff §6). Two parts:
//  1. Your Aramo account — the shared account fields, READ-ONLY here: Aramo has
//     no self-service profile write (GET /v1/me is read-only by design), so name
//     and email are shown as recorded by the organization.
//  2. Default landing page — the accepted design, shown as an HONEST SEAM:
//     a saved start page must persist per user across browsers, and Aramo has no
//     per-user preference service yet. Storing it in this browser and calling it
//     a preference would be false, so nothing is saved; Aramo opens App Home (or
//     the exact page a link points to) after sign-in. The backend contract this
//     needs is recorded in the Unified Multi-Product Experience report.
export function PreferencesView() {
  const me = useMe();
  const products = useMyProducts();
  const view = products.status === 'ready' ? products.view : null;
  const options = [
    { key: 'home', label: 'App Home · default', sub: 'Your apps and organization in one place', current: true, available: true },
    ...(['ats', 'esign'] as const).map((k) => {
      const p = productByKey(view, k);
      return {
        key: k,
        label: k === 'ats' ? 'Aramo ATS' : 'Aramo Sign',
        sub: p?.available ? 'Available to you' : "You don't have access",
        current: false,
        available: p?.available ?? false,
      };
    }),
  ];
  const org = me?.tenant.display_name ?? 'your organization';

  return (
    <section className="home-page home-prefs">
      <div className="home-hero">
        <div>
          <h1>My preferences</h1>
          <p>
            Personal settings{me?.user.display_name ? ` for ${me.user.display_name}` : ''} at {org}
          </p>
        </div>
      </div>

      <div className="home-panel" data-testid="prefs-account">
        <div className="home-panel__head">
          <h2>Your Aramo account</h2>
          <span className="home-pill home-pill--muted">Shared · read-only here</span>
        </div>
        <dl className="home-dl">
          <dt>Name</dt>
          <dd>{me?.user.display_name ?? '—'}</dd>
          <dt>Email</dt>
          <dd>{me?.user.email ?? '—'}</dd>
          <dt>Organization</dt>
          <dd>{me?.tenant.display_name ?? '—'}</dd>
          <dt>Roles</dt>
          <dd>{me && me.roles.length > 0 ? me.roles.join(' · ') : '—'}</dd>
        </dl>
        <p className="home-muted">Your name and email are managed by your organization admin.</p>
      </div>

      <div className="home-panel" data-testid="prefs-landing">
        <div className="home-panel__head">
          <h2>Default landing page</h2>
        </div>
        <p className="home-muted">
          Where Aramo opens when you sign in. Only for you, only for {org}. It doesn&apos;t change what you can access.
        </p>
        <ul className="home-choices">
          {options.map((o) => (
            <li key={o.key} className={`home-choice${o.current ? ' home-choice--on' : ''}${o.available ? '' : ' home-choice--off'}`}>
              <span className="home-choice__name">{o.label}</span>
              <span className="home-choice__sub">{o.sub}</span>
              {o.current ? <span className="home-pill home-pill--brand">Current</span> : null}
            </li>
          ))}
        </ul>
        <SettingsSeam
          icon={<IconDesk />}
          title="Choosing a different start page"
          vision={[
            'Pick App Home, Aramo ATS or Aramo Sign as the page Aramo opens after sign-in.',
            'Saved for you across browsers and devices; a link to a specific page always opens that page.',
            'If you lose access to the chosen app, Aramo falls back to App Home and explains why.',
          ]}
        >
          Saving a start page needs a per-user preference service, which Aramo doesn&apos;t have yet. Until it
          ships, Aramo opens App Home after sign-in — or the exact page a link points to.
        </SettingsSeam>
      </div>
    </section>
  );
}
