import { Link, useSearchParams } from 'react-router-dom';
import {
  Button,
  IconBriefcase,
  IconPencil,
  InlineAlert,
  productByKey,
  productEntryHref,
  readRememberedReturnContext,
  useMyProducts,
  type ProductAvailability,
  type ProductAvailabilityView,
  type ProductKey,
} from '@aramo/fe-foundation';
import { ORG_DENIED_NOTICE, ORG_SECTIONS, useMe } from '@aramo/org-admin-web';

import { OrgTileIcon } from './org-tile-icons';

// The Aramo App Home (accepted App Home handoff §5; frozen prototype 2026-10-18)
// — "My applications". Rendered STRICTLY from the backend-authoritative
// availability read (GET /v1/me/products): a product is an app card only when the
// organization subscribes to it; "Open" exists only when the backend says the
// person may use it now; products the organization doesn't subscribe to are
// listed under "Other Aramo products". The view never creates access.

interface ProductCopy {
  readonly name: string;
  readonly blurb: string;
  readonly short: string;
  readonly icon: JSX.Element;
}

const PRODUCT_COPY: Record<Exclude<ProductKey, 'org'>, ProductCopy> = {
  ats: { name: 'Aramo ATS', short: 'ATS', blurb: 'Requisitions, talent, submittals and placements', icon: <IconBriefcase /> },
  esign: { name: 'Aramo Sign', short: 'Sign', blurb: 'Send and track documents for e-signature', icon: <IconPencil /> },
};

function greeting(now: Date): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function firstName(display: string | null | undefined): string {
  return (display ?? '').trim().split(/\s+/)[0] ?? '';
}

interface Props {
  /** Test seam — replaces the GET /v1/me/products read. */
  readonly fetchFn?: () => Promise<ProductAvailabilityView>;
  /** Test seam — the "is organization admin" flag the shell derives from the session. */
  readonly isOrgAdmin?: boolean;
  /** Test seam — the clock. */
  readonly now?: Date;
}

function AppCard({ product, org }: { readonly product: ProductAvailability; readonly org: string }) {
  const key = product.key as Exclude<ProductKey, 'org'>;
  const copy = PRODUCT_COPY[key];
  const href = productEntryHref(product);
  const status = href !== null ? 'ready' : product.authorized ? 'inactive' : 'noaccess';
  return (
    <div className={`home-card${href === null ? ' home-card--off' : ''}`} data-testid={`home-tile-${product.key}`}>
      <div className="home-card__top">
        <span className="home-card__icon" aria-hidden="true">
          {copy.icon}
        </span>
        <span className="home-card__text">
          <span className="home-card__name">{copy.name}</span>
          <span className="home-card__blurb">{copy.blurb}</span>
        </span>
      </div>
      {status === 'ready' ? (
        <>
          <span className="home-pill home-pill--ok">Ready</span>
          <a className="home-open" href={href ?? undefined} data-testid={`home-open-${product.key}`}>
            Open {copy.short}
          </a>
        </>
      ) : status === 'noaccess' ? (
        <>
          <span className="home-pill home-pill--warn">No access</span>
          <p className="home-card__why">
            {org} has {copy.short}, but you have no {copy.short} role. Ask an organization admin.
          </p>
        </>
      ) : (
        <>
          <span className="home-pill home-pill--muted">Not available yet</span>
          <p className="home-card__why">{copy.name} isn't switched on for {org} yet.</p>
        </>
      )}
    </div>
  );
}

export function AppHomeView({ fetchFn, isOrgAdmin = false, now }: Props = {}) {
  const products = useMyProducts(fetchFn);
  const me = useMe();
  const [params] = useSearchParams();
  const denied = params.get('notice') === ORG_DENIED_NOTICE;
  const back = denied ? readRememberedReturnContext() : null;
  const org = me?.tenant.display_name ?? 'Your organization';
  const host = typeof window === 'undefined' ? '' : window.location.host;
  const view = products.status === 'ready' ? products.view : null;
  const orgProduct = productByKey(view, 'org');
  const showAdmin = isOrgAdmin || (orgProduct?.available ?? false);
  const subscribed = (view?.products ?? []).filter((p) => p.key !== 'org' && p.subscribed);
  const notSubscribed = (view?.products ?? []).filter((p) => p.key !== 'org' && !p.subscribed);
  const noAppRole = subscribed.length > 0 && subscribed.every((p) => !p.authorized);

  return (
    <section className="home-page">
      {denied ? (
        <div className="home-notice" role="status" data-testid="home-org-denied">
          <span>Organization administration needs the organization admin role.</span>
          {back !== null ? (
            <a href={back.href} className="home-notice__back">
              {back.label}
            </a>
          ) : null}
        </div>
      ) : null}
      <div className="home-hero">
        <div>
          <h1>
            {greeting(now ?? new Date())}
            {firstName(me?.user.display_name) ? `, ${firstName(me?.user.display_name)}` : ''}
          </h1>
          <p>
            {org}
            {host ? ` · ${host}` : ''}
          </p>
        </div>
        <div className="home-start">
          <Link to="/preferences" className="home-start__btn" data-testid="home-start-page">
            Start page · <strong>App Home</strong>
          </Link>
          <span className="home-start__cap">Opens when you sign in</span>
        </div>
      </div>

      <div className="home-label">My applications</div>
      {products.status === 'loading' ? <p className="home-muted">Loading your applications…</p> : null}
      {products.status === 'error' ? (
        <InlineAlert variant="error">
          <span>We couldn&apos;t load your applications.</span>{' '}
          <Button variant="secondary" size="sm" onClick={products.retry} data-testid="home-retry">
            Try again
          </Button>
        </InlineAlert>
      ) : null}
      {view !== null ? (
        <>
          {noAppRole && showAdmin ? (
            <div className="home-note" data-testid="home-no-app-role">
              You don&apos;t have a role in an Aramo app yet. As an organization admin you can still manage the
              organization below, including your own app roles.
            </div>
          ) : null}
          {subscribed.length > 0 ? (
            <div className="home-cards" data-testid="home-tiles">
              {subscribed.map((p) => (
                <AppCard key={p.key} product={p} org={org} />
              ))}
            </div>
          ) : (
            <p className="home-muted">{org} doesn&apos;t subscribe to an Aramo app yet.</p>
          )}
          {notSubscribed.length > 0 ? (
            <>
              <div className="home-label">Other Aramo products</div>
              <div className="home-others">
                {notSubscribed.map((p) => {
                  const copy = PRODUCT_COPY[p.key as Exclude<ProductKey, 'org'>];
                  return (
                    <div key={p.key} className="home-other" data-testid={`home-other-${p.key}`}>
                      <span className="home-other__icon" aria-hidden="true">
                        {copy.icon}
                      </span>
                      <span className="home-other__text">
                        <span className="home-other__name">{copy.name}</span>
                        <span className="home-other__why">
                          Not part of {org}&apos;s plan. Your organization admin can ask to add it.
                        </span>
                      </span>
                      <span className="home-pill home-pill--muted">Not subscribed</span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {showAdmin ? (
        <>
          <div className="home-label home-label--admin">
            Organization administration <span className="home-admin">ADMIN</span>
            <span className="home-label__cap">Shared by every Aramo app · not a subscription</span>
          </div>
          <div className="home-orgtiles" data-testid="home-org-tiles">
            {ORG_SECTIONS.map((s) => (
              <Link key={s.key} to={`/org/${s.key}`} className="home-orgtile" data-testid={`home-org-${s.key}`}>
                <OrgTileIcon section={s.key} />
                <span>
                  <span className="home-orgtile__name">{s.label}</span>
                  <span className="home-orgtile__sub">{s.key === 'domain' && host ? host : s.sub}</span>
                </span>
              </Link>
            ))}
          </div>
        </>
      ) : (
        <p className="home-footnote">Organization settings are managed by your organization admins.</p>
      )}
    </section>
  );
}
