import './commercial.css';

// CCP-B1 — the Commercial screens later slices build (Subscriptions B3, Catalog B2,
// Contracts B4, Policy and Audit B5): the rail item and the route exist now, and
// the page renders its design header with the designed disabled state
// (PLATFORM-UX-1 R-13; the dashed "not available" card of Commercial Control Plane
// v1.0.dc.html). No data is read and no action is offered.

export type CommercialPlaceholderPage = 'subscriptions' | 'catalog' | 'contracts' | 'policy' | 'audit';

/** The design's page headers (Commercial Control Plane v1.0.dc.html). */
export const PLACEHOLDER_COPY: Readonly<Record<CommercialPlaceholderPage, { readonly title: string; readonly intro: string; readonly name: string }>> = {
  subscriptions: {
    title: 'Subscriptions',
    name: 'Subscriptions',
    intro: 'Every open base subscription across tenants. MANUAL rows are governed contracts; SELF-SERVICE rows are owned by Stripe and read-only here.',
  },
  catalog: {
    title: 'Catalog',
    name: 'The catalog',
    intro: 'Products, their plans and plan versions. A published version never changes: subscriptions pin it, and edits happen in a new draft that Finance and an Owner approve before it publishes.',
  },
  contracts: {
    title: 'Contracts',
    name: 'Contracts',
    intro: 'Enterprise MANUAL subscriptions recorded with their evidence. This is a record of what was agreed, not a quoting tool; changes go through change requests.',
  },
  policy: {
    title: 'Commercial policy',
    name: 'Commercial policy',
    intro: 'Thresholds and windows that decide which approval chain a request gets. Exactly one version is active. Activating or rolling back a version is itself a change request, and existing requests keep the chain they were created with.',
  },
  audit: {
    title: 'Commercial audit',
    name: 'The commercial audit',
    intro: 'An append-only record of every commercial event. Entries can’t be edited or deleted — corrections are new events.',
  },
};

export function CommercialPlaceholderView({ page }: { readonly page: CommercialPlaceholderPage }) {
  const c = PLACEHOLDER_COPY[page];
  return (
    <div className="pc-page" data-testid={`commercial-${page}`}>
      <div className="pc-head">
        <h1 className="pc-h1">{c.title}</h1>
        <p className="pc-intro">{c.intro}</p>
      </div>
      <section className="pc-soon" data-testid="commercial-placeholder">
        <b>{c.name} isn’t available in the console yet</b>
        <p className="pc-soon__body">This screen opens in a later release. Change requests made for it already appear in Approvals.</p>
      </section>
    </div>
  );
}
