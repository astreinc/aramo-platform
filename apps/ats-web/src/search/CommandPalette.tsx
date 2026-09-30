import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, Input } from '@aramo/fe-foundation';

import { ENTITY_LABEL, type SearchHit } from './enterprise-search-api';
import { useEnterpriseSearch } from './use-enterprise-search';
import { Highlight, SnippetText } from './highlight';

// Enterprise Search GS-1 — the global ⌘K command palette. It is a LEAN consumer of the same
// /v1/search authority as the full Search view (shared useEnterpriseSearch hook): "I know
// roughly what I'm looking for; take me there quickly." No filters, no fields — just a query,
// grouped results, keyboard-first navigation, and a "View all" escape hatch to the full page.
// It is NOT a second search implementation and shares the exact result/authority semantics.

interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const { status, results, submitted } = useEnterpriseSearch(query);

  // Flatten authorized groups into an ordered, keyboard-navigable list, preserving the group
  // boundaries for rendering and a stable global index for aria-activedescendant.
  const rendered = useMemo(() => {
    const groups = (results?.groups ?? []).filter((g) => g.unauthorized !== true && g.hits.length > 0);
    let running = 0;
    return groups.map((g) => ({
      entity_type: g.entity_type,
      items: g.hits.map((hit) => ({ hit, index: running++ })),
    }));
  }, [results]);
  const flatHits = useMemo<readonly SearchHit[]>(
    () => rendered.flatMap((g) => g.items.map((x) => x.hit)),
    [rendered],
  );

  const [active, setActive] = useState(0);
  useEffect(() => {
    setActive(0);
  }, [flatHits]);
  // Clear the query each time the palette closes so it opens fresh.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const go = (hit: SearchHit | undefined): void => {
    if (hit === undefined) return;
    onOpenChange(false);
    navigate(hit.route);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (flatHits.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flatHits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(flatHits[active]);
    }
  };

  const viewAll = (): void => {
    onOpenChange(false);
    navigate(submitted === '' ? '/search' : `/search?q=${encodeURIComponent(submitted)}`);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title="Search"
      description="Find talent, requisitions, companies, and contacts."
    >
      <div className="rc-palette">
        <Input
          id="cmdk-input"
          type="search"
          aria-label="Search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search talent, companies, requisitions, contacts…"
          autoComplete="off"
          role="combobox"
          aria-expanded={flatHits.length > 0}
          aria-controls="cmdk-listbox"
          aria-activedescendant={flatHits.length > 0 ? `cmdk-opt-${active}` : undefined}
        />

        {submitted === '' ? (
          <p className="rc-palette__hint" data-testid="cmdk-prompt">
            Type to search.
          </p>
        ) : status === 'loading' ? (
          <p className="rc-palette__hint" role="status" data-testid="cmdk-loading">
            Searching…
          </p>
        ) : status === 'error' ? (
          <p className="rc-palette__hint rc-palette__hint--error" role="alert" data-testid="cmdk-error">
            Search is temporarily unavailable. Try again.
          </p>
        ) : flatHits.length === 0 ? (
          <p className="rc-palette__hint" data-testid="cmdk-empty">
            No matching records.
          </p>
        ) : (
          <ul id="cmdk-listbox" role="listbox" aria-label="Search results" className="rc-palette__list">
            {rendered.map((group) => (
              <li key={group.entity_type} role="presentation" className="rc-palette__group">
                <div className="rc-palette__group-title" role="presentation">
                  {ENTITY_LABEL[group.entity_type]}
                </div>
                <ul role="presentation" className="rc-palette__group-list">
                  {group.items.map(({ hit, index }) => (
                    <li
                      key={hit.entity_id}
                      id={`cmdk-opt-${index}`}
                      role="option"
                      aria-selected={index === active}
                      className={
                        index === active ? 'rc-palette__opt rc-palette__opt--active' : 'rc-palette__opt'
                      }
                      onMouseEnter={() => setActive(index)}
                      onClick={() => go(hit)}
                    >
                      <span className="rc-palette__opt-label">
                        <Highlight text={hit.display_label} query={submitted} />
                      </span>
                      {hit.subtitle !== null && hit.subtitle !== '' ? (
                        <span className="rc-palette__opt-subtitle">
                          <Highlight text={hit.subtitle} query={submitted} />
                        </span>
                      ) : null}
                      {hit.snippet !== null && hit.snippet !== '' ? (
                        <span className="rc-palette__opt-snippet">
                          <SnippetText snippet={hit.snippet} />
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}

        <div className="rc-palette__footer">
          <Button unstyled type="button" className="rc-palette__viewall" onClick={viewAll}>
            View all results
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
