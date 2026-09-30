import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  FormField,
  InlineAlert,
  Input,
  PageHeader,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';

import { ENTITY_LABEL, type SearchGroup } from './enterprise-search-api';
import { useEnterpriseSearch } from './use-enterprise-search';
import { Highlight, SnippetText } from './highlight';

// Enterprise Search GS-1 — the full Search page. Converged onto the UNIFIED /v1/search
// contract via the shared useEnterpriseSearch hook (the former per-entity fan-out is gone).
// The backend orchestrator fans out server-side and returns grouped, authority-safe, lean
// hits; this view only presents them. The ⌘K palette consumes the SAME hook/contract — the
// two surfaces differ in presentation, never in semantics or authority.
//
// Server-authoritative navigation: every hit carries its own `route` (contacts now route to
// their company — the old R-CONTACTS non-linking limitation is resolved by the backend
// providing a canonical target). Visibility/masking/consent are enforced server-side; the
// hits ARE the authorized, lean truth (no client-side filtering).

const SEARCH_SCOPES = ['talent:search', 'company:search', 'requisition:search', 'contact:search'];

interface SearchViewProps {
  // Test seam — a fixed session so the no-access gate is exercisable without the session hook.
  readonly sessionOverride?: Session;
}

export function SearchView({ sessionOverride }: SearchViewProps = {}) {
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ?? (sessionState.status === 'authenticated' ? sessionState.session : null);

  const canSearch =
    session !== null &&
    Array.isArray(session.scopes) &&
    SEARCH_SCOPES.some((s) => hasScope(session, s));

  // Seed from ?q= so the palette's "View all results" lands here with the query intact.
  const [params] = useSearchParams();
  const [query, setQuery] = useState(() => params.get('q') ?? '');
  const { status, results, error, submitted } = useEnterpriseSearch(query);

  return (
    <section>
      <PageHeader
        title="Search"
        description="Quick-search across the records you can see. Results respect your visibility."
      />

      {!canSearch ? (
        <p role="status" data-testid="search-no-access">
          You don’t have access to search any records.
        </p>
      ) : (
        <>
          <FormField label="Search">
            <Input
              id="search-input"
              type="search"
              aria-label="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search talent, companies, requisitions, contacts…"
              autoComplete="off"
            />
          </FormField>

          {submitted === '' ? (
            <p data-testid="search-prompt">Type to search.</p>
          ) : status === 'loading' ? (
            <p role="status" data-testid="search-loading">
              Searching…
            </p>
          ) : status === 'error' ? (
            <InlineAlert variant="error">{error}</InlineAlert>
          ) : results !== null && results.groups.length > 0 ? (
            results.groups.map((group) => (
              <SearchGroupSection key={group.entity_type} group={group} query={submitted} />
            ))
          ) : (
            <p className="search-section__empty" data-testid="search-empty">
              No matching records.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function SearchGroupSection({ group, query }: { readonly group: SearchGroup; readonly query: string }) {
  const label = ENTITY_LABEL[group.entity_type];
  return (
    <section className="search-section" aria-label={label}>
      <h2 className="search-section__title">{label}</h2>
      {group.unauthorized === true ? (
        <p className="search-section__empty">You don’t have access to search {label.toLowerCase()}.</p>
      ) : group.hits.length === 0 ? (
        <p className="search-section__empty">No matching {label.toLowerCase()}.</p>
      ) : (
        <ul className="search-section__rows">
          {group.hits.map((hit) => (
            <li key={hit.entity_id} className="search-section__row">
              <Link to={hit.route}>
                <Highlight text={hit.display_label} query={query} />
              </Link>
              {hit.subtitle !== null && hit.subtitle !== '' ? (
                <span className="search-section__secondary">
                  {' — '}
                  <Highlight text={hit.subtitle} query={query} />
                </span>
              ) : null}
              {hit.snippet !== null && hit.snippet !== '' ? (
                <span className="search-section__snippet" data-testid="resume-snippet">
                  {' · '}
                  <SnippetText snippet={hit.snippet} />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
