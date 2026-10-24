import { useId, useState, type KeyboardEvent } from 'react';
import { Button, Input } from '@aramo/fe-foundation';

import './platform-components.css';

// PLATFORM-UX-1 F-1 — the tag input (handoff §12; the Edit details dialog's
// product tags): mono chips with a remove ×, and a borderless input that adds a
// tag on Enter. Composed locally — the frozen Tag/TagList have no remove
// affordance. Tags are normalised (default: UPPER_SNAKE A–Z 0–9 _) and capped.

export interface TagInputProps {
  readonly label: string;
  readonly tags: readonly string[];
  readonly onChange: (tags: string[]) => void;
  /** Default: "TAG ↵". */
  readonly placeholder?: string;
  /** Maximum number of tags. Default: 16. */
  readonly max?: number;
  /** Draft normaliser. Default: upper-case and drop anything outside A–Z 0–9 _. */
  readonly normalize?: (draft: string) => string;
}

const defaultNormalize = (draft: string): string => draft.toUpperCase().replace(/[^A-Z0-9_]/g, '');

export function TagInput({
  label,
  tags,
  onChange,
  placeholder = 'TAG ↵',
  max = 16,
  normalize = defaultNormalize,
}: TagInputProps) {
  const id = useId();
  const [draft, setDraft] = useState('');

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && draft) {
      e.preventDefault();
      if (!tags.includes(draft) && tags.length < max) onChange([...tags, draft]);
      setDraft('');
    } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div className="pw-field">
      <label className="pw-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="pw-taginput">
        {tags.map((t) => (
          <span key={t} className="pw-taginput__tag">
            {t}
            <Button
              unstyled
              className="pw-taginput__rm"
              aria-label={`Remove ${t}`}
              onClick={() => onChange(tags.filter((x) => x !== t))}
            >
              ×
            </Button>
          </span>
        ))}
        <Input
          id={id}
          unstyled
          className="pw-taginput__input"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(normalize(e.target.value))}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}
