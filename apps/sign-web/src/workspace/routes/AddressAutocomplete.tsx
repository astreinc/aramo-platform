import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { TextIn } from '../ui';

// Aramo-Sign-Signup-Federated-Owner Amendment A1 §2.3 — street-address
// autocomplete through the platform-admin proxy (POST
// /v1/signup/sign/address/suggest, verified signup token required). Fails open:
// unconfigured, slow (> 2 s), rate-limited or failing → no list, no error, the
// manual form keeps working. A suggestion is not proof; the server validates.

export interface AddressSuggestion {
  label: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state_province: string;
  postal_code: string;
}

interface SuggestResponse {
  available?: boolean;
  suggestions?: AddressSuggestion[];
  attribution?: { label: string; url: string } | null;
}

export const SUGGEST_MIN_CHARS = 3;
export const SUGGEST_DEBOUNCE_MS = 250;
export const SUGGEST_TIMEOUT_MS = 2000;

export function AddressAutocomplete({
  id,
  token,
  value,
  onChange,
  onSelect,
  invalid,
  describedBy,
  className,
}: {
  id: string;
  token: string;
  value: string;
  onChange: (v: string) => void;
  onSelect: (s: AddressSuggestion) => void;
  invalid?: boolean;
  describedBy?: string;
  /** Extra class on the input (the signup activation styles it). */
  className?: string;
}) {
  const listId = useId();
  const [query, setQuery] = useState<string | null>(null); // set only by typing
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [attribution, setAttribution] = useState<{ label: string; url: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    ctrl.current?.abort();
    if (query === null || query.trim().length < SUGGEST_MIN_CHARS) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    const c = new AbortController();
    ctrl.current = c;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const debounce = setTimeout(() => {
      timeout = setTimeout(() => c.abort(), SUGGEST_TIMEOUT_MS);
      fetch('/v1/signup/sign/address/suggest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, text: query.trim() }),
        signal: c.signal,
      })
        .then(async (res) => {
          if (!res.ok) throw new Error('unavailable');
          const j = (await res.json()) as SuggestResponse;
          if (c.signal.aborted) return;
          const list = j.available === true && Array.isArray(j.suggestions) ? j.suggestions : [];
          setSuggestions(list);
          setAttribution(j.attribution ?? null);
          setActive(-1);
          setOpen(list.length > 0);
        })
        .catch(() => {
          // Fail open: silently fall back to manual entry.
          if (ctrl.current === c) {
            setSuggestions([]);
            setOpen(false);
          }
        })
        .finally(() => clearTimeout(timeout));
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      clearTimeout(debounce);
      clearTimeout(timeout);
      c.abort();
    };
  }, [query, token]);

  const choose = (s: AddressSuggestion) => {
    ctrl.current?.abort();
    setQuery(null);
    setOpen(false);
    setSuggestions([]);
    setActive(-1);
    onSelect(s);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      if (suggestions.length === 0) return;
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      if (suggestions.length === 0) return;
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a <= 0 ? suggestions.length - 1 : a - 1));
    } else if (e.key === 'Enter') {
      const s = open && active >= 0 ? suggestions[active] : undefined;
      if (s !== undefined) {
        e.preventDefault();
        choose(s);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      }
    }
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;
  const expanded = open && suggestions.length > 0;

  return (
    <div className="sg-combo">
      <TextIn
        id={id}
        {...(className !== undefined ? { className } : {})}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        aria-invalid={invalid === true ? true : undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        maxLength={200}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      />
      <div className="sg-combo__pop" hidden={!expanded}>
        <ul id={listId} role="listbox" aria-label="Address suggestions" className="sg-combo__list">
          {expanded
            ? suggestions.map((s, i) => (
                <li
                  key={`${s.label}-${i}`}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'sg-combo__opt sg-combo__opt--active' : 'sg-combo__opt'}
                  // Keep focus in the input so blur does not close the list first.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(s)}
                >
                  {s.label}
                </li>
              ))
            : null}
        </ul>
        {expanded && attribution !== null ? (
          <div className="sg-combo__attr">
            <a href={attribution.url} target="_blank" rel="noopener noreferrer">
              {attribution.label}
            </a>
          </div>
        ) : null}
      </div>
    </div>
  );
}
