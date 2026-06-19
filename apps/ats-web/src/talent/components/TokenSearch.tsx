import { Icons } from '../../ui';
import type { SearchToken } from '../talent-workspace';

// TokenSearch — the tokenized search box (skill: / loc: / owner: + free text).
// Feature-local. Committed tokens render as removable chips; unsupported keys
// (status: / intouch:) render as FLAGGED chips that do not filter (the field
// doesn't exist) — kept visible so the recruiter sees they were ignored rather
// than silently dropped. Free text matches name / skills / location.

interface TokenSearchProps {
  readonly tokens: readonly SearchToken[];
  readonly draft: string;
  readonly onDraftChange: (v: string) => void;
  /** Commit any key:value in the draft into chips (Enter / space). */
  readonly onCommit: () => void;
  readonly onRemove: (index: number) => void;
}

export function TokenSearch({
  tokens,
  draft,
  onDraftChange,
  onCommit,
  onRemove,
}: TokenSearchProps) {
  return (
    <div className="rc-tokenbox" role="search">
      <Icons.IconSearch className="rc-tokenbox__icon" aria-hidden="true" />
      {tokens.map((t, i) => (
        <span
          key={`${t.key}:${t.value}:${i}`}
          className={`rc-token${t.supported ? '' : ' rc-token--flagged'}`}
          title={
            t.supported
              ? undefined
              : `${t.key}: is not searchable yet — this chip does not filter`
          }
        >
          <span className="rc-token__k">{t.key}:</span>
          {t.value}
          {!t.supported ? <span className="rc-token__warn">·ignored</span> : null}
          <button
            type="button"
            aria-label={`Remove ${t.key}:${t.value}`}
            onClick={() => onRemove(i)}
          >
            <Icons.IconX />
          </button>
        </span>
      ))}
      <input
        className="rc-tokenbox__input"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            // commit if the draft holds a key:value; let plain spaces through
            if (/[a-zA-Z]+:[^\s]/.test(draft)) {
              e.preventDefault();
              onCommit();
            }
          } else if (e.key === 'Backspace' && draft === '' && tokens.length > 0) {
            onRemove(tokens.length - 1);
          }
        }}
        placeholder="Name, skill, title…  try  skill:Rust · loc:austin · owner:me"
        aria-label="Search talent"
      />
      <span className="rc-tokenbox__hint">skill: loc: owner:</span>
    </div>
  );
}
