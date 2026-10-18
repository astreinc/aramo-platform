import { useEffect, useState } from 'react';
import {
  IconBriefcase,
  IconBuilding,
  IconFile,
  InlineAlert,
  PageHeader,
  safeErrorMessage,
} from '@aramo/fe-foundation';
import { Link } from 'react-router-dom';

import {
  fetchMyProducts,
  productEntryHref,
  type ProductAvailability,
  type ProductAvailabilityView,
  type ProductKey,
} from './products-api';

// D-ORG-2/3 — the App Home: one tile per Aramo product, rendered STRICTLY from
// the backend-authoritative availability read (§3.D). A tile is an entry only
// when the backend says `available`; otherwise it states honestly why not
// (not in the subscription vs. no access for this user) — never a dead knob.

interface ProductCopy {
  readonly name: string;
  readonly blurb: string;
  readonly icon: JSX.Element;
}

const PRODUCT_COPY: Record<ProductKey, ProductCopy> = {
  ats: {
    name: 'Aramo ATS',
    blurb: 'Requisitions, talent, pipelines and placements.',
    icon: <IconBriefcase />,
  },
  esign: {
    name: 'Aramo Sign',
    blurb: 'Send, sign and track documents.',
    icon: <IconFile />,
  },
  org: {
    name: 'Organization administration',
    blurb: 'Profile, sites, users, roles and the audit log — shared by every product.',
    icon: <IconBuilding />,
  },
};

type State =
  | { status: 'loading' }
  | { status: 'ready'; view: ProductAvailabilityView }
  | { status: 'error'; message: string };

interface Props {
  /** Test seam — replaces the GET /v1/me/products read. */
  readonly fetchFn?: () => Promise<ProductAvailabilityView>;
}

function unavailableCopy(p: ProductAvailability): string {
  if (!p.subscribed) return "Not included in your organization's subscription.";
  if (!p.authorized) return 'You do not have access. Ask your organization administrator.';
  return 'Not yet activated for this organization.';
}

function ProductTile({ product }: { readonly product: ProductAvailability }) {
  const copy = PRODUCT_COPY[product.key];
  const href = productEntryHref(product);
  const body = (
    <>
      <span className="home-tile__icon" aria-hidden="true">
        {copy.icon}
      </span>
      <span className="home-tile__name">{copy.name}</span>
      <span className="home-tile__blurb">{copy.blurb}</span>
      {href === null ? <span className="home-tile__why">{unavailableCopy(product)}</span> : null}
    </>
  );
  if (href === null) {
    return (
      <div className="home-tile home-tile--off" data-testid={`home-tile-${product.key}`} aria-disabled="true">
        {body}
      </div>
    );
  }
  // The organization section is a route of THIS SPA; the products are sibling
  // SPAs entered through their own consumer login (full navigation).
  if (product.key === 'org') {
    return (
      <Link to={href} className="home-tile" data-testid={`home-tile-${product.key}`}>
        {body}
      </Link>
    );
  }
  return (
    <a href={href} className="home-tile" data-testid={`home-tile-${product.key}`}>
      {body}
    </a>
  );
}

export function AppHomeView({ fetchFn }: Props = {}) {
  const fetcher = fetchFn ?? fetchMyProducts;
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetcher()
      .then((view) => {
        if (!cancelled) setState({ status: 'ready', view });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', message: safeErrorMessage(err, 'Could not load your products.') });
      });
    return () => {
      cancelled = true;
    };
  }, [fetcher]);

  return (
    <section className="home-page">
      <PageHeader title="Aramo" description="Your organization's products." />
      {state.status === 'loading' ? <p className="home-muted">Loading your products…</p> : null}
      {state.status === 'error' ? <InlineAlert variant="error">{state.message}</InlineAlert> : null}
      {state.status === 'ready' ? (
        <div className="home-tiles" data-testid="home-tiles">
          {state.view.products.map((p) => (
            <ProductTile key={p.key} product={p} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
