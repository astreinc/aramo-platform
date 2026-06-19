import * as RadixPopover from '@radix-ui/react-popover';
import { useEffect, useId, useRef, useState } from 'react';

import { autocompleteAddress, getAddressDetails } from './companies-api';
import type { AddressDetails, AddressSuggestion } from './types';

// AddressTypeahead — Address-Autocomplete v1.0 (ats-web consumer).
//
// The async sibling of the fe-foundation Combobox. Combobox is CONSUME-ONLY /
// frozen (S5c-3) and SYNCHRONOUS (it filters a full item set supplied
// upfront); an address typeahead must query the backend per keystroke. So this
// is a NEW component that REUSES Combobox's Radix-Popover + ARIA-combobox
// pattern, not an edit to it.
//
// Flow: type ≥3 chars → debounced GET /v1/address-lookup/autocomplete →
// render suggestions → select → GET /v1/address-lookup/details → hand the
// structured fields to onSelectAddress (which populates the form's existing,
// still-editable address inputs + stamps the place reference).
//
// NEVER-BLOCK (directive R7): the backend returns empty/null on disable or
// provider failure, and any transport error here is swallowed to a soft
// "unavailable — enter manually" notice. The component NEVER prevents manual
// entry — it sits above the plain address inputs, which always work.

const MIN_QUERY_LENGTH = 3;
const DEBOUNCE_MS = 250;

interface AddressTypeaheadProps {
  /** Called with the resolved structured address when a suggestion is picked. */
  readonly onSelectAddress: (details: AddressDetails) => void;
  readonly disabled?: boolean;
  readonly testId?: string;
}

export function AddressTypeahead({
  onSelectAddress,
  disabled = false,
  testId,
}: AddressTypeaheadProps) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<readonly AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [highlighted, setHighlighted] = useState(0);

  const listboxId = useId();
  // Monotonic token so a slow autocomplete response can't overwrite a newer
  // one (last-write-wins by request order).
  const requestSeq = useRef(0);

  // Address-Autocomplete v1.1 — Google Autocomplete SESSION TOKEN. One UUID is
  // generated lazily when a session begins (first ≥3-char query), threaded
  // through every autocomplete call AND the matching details call, then CLEARED
  // on selection (details resolved) or abandon (field cleared) so the next
  // input opens a NEW session. This makes Google bill one session per lookup
  // instead of per keystroke.
  const sessionTokenRef = useRef<string | null>(null);
  // When a selection programmatically rewrites the query to the chosen
  // description, the [query] effect must NOT fire a fresh (billed) autocomplete
  // or open a new session for that text.
  const suppressNextSearchRef = useRef(false);

  function ensureSessionToken(): string {
    if (sessionTokenRef.current === null) {
      sessionTokenRef.current = crypto.randomUUID();
    }
    return sessionTokenRef.current;
  }

  // Debounced autocomplete. Below the min length we clear + close without a
  // call (saves the paid request and matches the BE's min-3 guard).
  useEffect(() => {
    if (suppressNextSearchRef.current) {
      // This query change came from a selection, not the user — skip the
      // search and the session it would open.
      suppressNextSearchRef.current = false;
      return;
    }
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      // Field cleared / abandoned → rotate: the next session gets a new token.
      sessionTokenRef.current = null;
      setSuggestions([]);
      setLoading(false);
      setOpen(false);
      return;
    }
    const token = ensureSessionToken();
    const seq = ++requestSeq.current;
    setLoading(true);
    setUnavailable(false);
    const timer = setTimeout(() => {
      autocompleteAddress(q, token)
        .then((res) => {
          if (seq !== requestSeq.current) return; // stale
          setSuggestions(res.suggestions);
          setHighlighted(0);
          setOpen(true);
          setLoading(false);
        })
        .catch(() => {
          if (seq !== requestSeq.current) return;
          // Soft-fail: the lookup is unavailable; manual entry still works.
          setSuggestions([]);
          setUnavailable(true);
          setOpen(true);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  async function choose(suggestion: AddressSuggestion): Promise<void> {
    // Close the session with the SAME token that opened it (the autocomplete
    // calls used it). undefined only if somehow no search ran first.
    const token = sessionTokenRef.current ?? undefined;
    setOpen(false);
    suppressNextSearchRef.current = true;
    setQuery(suggestion.description);
    setResolving(true);
    try {
      const res = await getAddressDetails(suggestion.place_id, token);
      if (res.details !== null) {
        onSelectAddress(res.details);
      } else {
        // Provider couldn't resolve details — surface the manual-entry notice
        // (re-open the popover; v1.0 relied on a spurious re-search to do this,
        // which the session-token suppression intentionally removed).
        setUnavailable(true);
        setOpen(true);
      }
    } catch {
      setUnavailable(true);
      setOpen(true);
    } finally {
      setResolving(false);
      // Session closed — the next typed query opens a fresh one.
      sessionTokenRef.current = null;
    }
  }

  function onKeyDown(ev: React.KeyboardEvent<HTMLInputElement>): void {
    if (ev.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (suggestions.length === 0) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setHighlighted((h) => Math.min(suggestions.length - 1, h + 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setHighlighted((h) => Math.max(0, h - 1));
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      const target = suggestions[Math.min(highlighted, suggestions.length - 1)];
      if (target !== undefined) void choose(target);
    }
  }

  const clamped = Math.min(highlighted, Math.max(suggestions.length - 1, 0));

  return (
    <div className="address-typeahead">
      <RadixPopover.Root open={open} onOpenChange={setOpen}>
        <RadixPopover.Anchor asChild>
          <input
            type="text"
            className="tc-combobox__input address-typeahead__input"
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-label="Search for an address"
            placeholder="Start typing an address…"
            value={query}
            disabled={disabled || resolving}
            onChange={(ev) => setQuery(ev.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => {
              if (suggestions.length > 0 || loading || unavailable) setOpen(true);
            }}
            data-testid={testId}
          />
        </RadixPopover.Anchor>
        <RadixPopover.Portal>
          <RadixPopover.Content
            className="tc-combobox__content address-typeahead__content"
            sideOffset={4}
            align="start"
            // Keep focus in the input so typing continues uninterrupted.
            onOpenAutoFocus={(ev) => ev.preventDefault()}
          >
            <ul
              id={listboxId}
              role="listbox"
              aria-label="Address suggestions"
              className="tc-combobox__listbox"
            >
              {loading ? (
                <li className="tc-combobox__empty">Searching…</li>
              ) : unavailable ? (
                <li className="tc-combobox__empty">
                  Address lookup unavailable — enter the address manually.
                </li>
              ) : suggestions.length === 0 ? (
                <li className="tc-combobox__empty">No matches.</li>
              ) : (
                suggestions.map((s, idx) => (
                  <li
                    key={s.place_id}
                    role="option"
                    aria-selected={idx === clamped}
                    data-highlighted={idx === clamped ? 'true' : undefined}
                    className="tc-combobox__option"
                    onMouseEnter={() => setHighlighted(idx)}
                    onClick={() => void choose(s)}
                    data-testid={
                      testId !== undefined ? `${testId}-option-${s.place_id}` : undefined
                    }
                  >
                    <span className="tc-combobox__option-label">{s.primary_text}</span>
                    {s.secondary_text !== '' && (
                      <span className="tc-combobox__option-description">
                        {s.secondary_text}
                      </span>
                    )}
                  </li>
                ))
              )}
            </ul>
          </RadixPopover.Content>
        </RadixPopover.Portal>
      </RadixPopover.Root>
    </div>
  );
}
