import { useEffect, useState } from 'react';

import {
  enterpriseSearch,
  type EnterpriseSearchOptions,
  type SearchResults,
} from './enterprise-search-api';

// Enterprise Search GS-1 — the SHARED search hook. Debounces the query, calls the single
// /v1/search client, and exposes a small state machine. Both SearchView and the ⌘K palette
// use this hook, so they share one implementation, one contract, and one authority model —
// the palette is a consumer of the same search authority, never a second search.

const DEBOUNCE_MS = 300;

export type SearchStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UseEnterpriseSearchState {
  readonly status: SearchStatus;
  readonly results: SearchResults | null;
  readonly error: string | null;
  // The debounced query the current results correspond to (for highlight alignment).
  readonly submitted: string;
}

export function useEnterpriseSearch(
  query: string,
  opts?: EnterpriseSearchOptions,
): UseEnterpriseSearchState {
  const [submitted, setSubmitted] = useState('');
  const [state, setState] = useState<Omit<UseEnterpriseSearchState, 'submitted'>>({
    status: 'idle',
    results: null,
    error: null,
  });

  // Debounce input → submitted query.
  useEffect(() => {
    const trimmed = query.trim();
    const handle = setTimeout(() => setSubmitted(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  // Serialize the entity-type option so the effect key is stable across renders.
  const entityKey = opts?.entityTypes === undefined ? '' : [...opts.entityTypes].join(',');
  const limit = opts?.limit;

  useEffect(() => {
    if (submitted === '') {
      setState({ status: 'idle', results: null, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, status: 'loading', error: null }));
    void enterpriseSearch(submitted, {
      entityTypes: entityKey === '' ? undefined : (entityKey.split(',') as never),
      limit,
    })
      .then((results) => {
        if (cancelled) return;
        setState({ status: 'ready', results, error: null });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ status: 'error', results: null, error: 'Search is temporarily unavailable. Try again.' });
      });
    return () => {
      cancelled = true;
    };
  }, [submitted, entityKey, limit]);

  return { ...state, submitted };
}
