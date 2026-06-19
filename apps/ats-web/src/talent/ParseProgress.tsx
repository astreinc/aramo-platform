import { Icons } from '../ui';

type ParsePhase = 'uploading' | 'parsing';

interface ParseProgressProps {
  readonly phase: ParsePhase;
  readonly fileName: string;
}

// Add-Talent parsing card (phase 2) — the progress shown between the drop and
// the form. The two steps map 1:1 to the two REAL network phases (the
// presigned PUT upload, then the deterministic parse-to-prefill call). No
// fabricated steps: the mockup's "Redacting SSN" / "Checking for duplicates"
// steps are dropped — SSN redaction happens server-side on the async
// résumé-text re-extract (not this synchronous call), and there is no dedup.
const STEPS: ReadonlyArray<{ phase: ParsePhase; label: string }> = [
  { phase: 'uploading', label: 'Uploading résumé' },
  { phase: 'parsing', label: 'Extracting stated facts' },
];

export function ParseProgress({ phase, fileName }: ParseProgressProps) {
  const activeIndex = STEPS.findIndex((s) => s.phase === phase);
  const pct = ((activeIndex + 1) / STEPS.length) * 100;
  return (
    <div className="rc-parsing" role="status" aria-live="polite">
      <div className="rc-parsing__file">
        <span className="rc-parsing__fic" aria-hidden="true">
          <Icons.IconFile />
        </span>
        <div>
          <div className="rc-parsing__fn">{fileName}</div>
          <div className="rc-parsing__fs">
            {phase === 'uploading' ? 'Uploading…' : 'Parsing…'}
          </div>
        </div>
      </div>
      <div className="rc-parsing__bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <ol className="rc-parsing__steps">
        {STEPS.map((step, i) => {
          const state = i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'upcoming';
          return (
            <li
              key={step.label}
              className={`rc-pstep${state === 'done' ? ' rc-pstep--done' : ''}${
                state === 'active' ? ' rc-pstep--active' : ''
              }`}
            >
              <span className="rc-pstep__d" aria-hidden="true">
                {state === 'done' ? <Icons.IconCheck /> : null}
              </span>
              {step.label}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
