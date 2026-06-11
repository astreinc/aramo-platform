import * as RadixPopover from '@radix-ui/react-popover';
import { useEffect, useId, useRef, useState } from 'react';

import { autocompleteAddress, getAddressDetails } from './companies-api';
import type { AddressDetails, AddressSuggestion } from './types';

// AddressTypeahead — Address-Autocomplete v1.0 (recruiter-console consumer).
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

  // Debounced autocomplete. Below the min length we clear + close without a
  // call (saves the paid request and matches the BE's min-3 guard).
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      setSuggestions([]);
      setLoading(false);
      setOpen(false);
      return;
    }
    const seq = ++requestSeq.current;
    setLoading(true);
    setUnavailable(false);
    const timer = setTimeout(() => {
      autocompleteAddress(q)
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
    setOpen(false);
    setQuery(suggestion.description);
    setResolving(true);
    try {
      const res = await getAddressDetails(suggestion.place_id);
      if (res.details !== null) {
        onSelectAddress(res.details);
      } else {
        // Provider couldn't resolve details — leave the fields for manual entry.
        setUnavailable(true);
      }
    } catch {
      setUnavailable(true);
    } finally {
      setResolving(false);
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
