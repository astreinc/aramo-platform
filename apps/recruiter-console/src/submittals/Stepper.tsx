import {
  SUBMITTAL_STATE_LABELS,
  WIZARD_STEPS,
  type SubmittalStateValue,
} from './types';

interface StepperProps {
  readonly currentState: SubmittalStateValue;
}

// Stepper — renders the 5 mainline steps with the current one highlighted.
// Revoked is NOT a step; it's surfaced inline by the wizard host as a
// terminal alert.
export function Stepper({ currentState }: StepperProps) {
  const currentIdx =
    currentState === 'revoked'
      ? -1
      : WIZARD_STEPS.indexOf(currentState);

  return (
    <ol
      aria-label="Submittal progress"
      className="r6-stepper"
      style={{
        display: 'flex',
        gap: '0.5rem',
        listStyle: 'none',
        padding: 0,
        margin: '0 0 1.5rem 0',
        flexWrap: 'wrap',
      }}
    >
      {WIZARD_STEPS.map((step, idx) => {
        const completed = currentIdx > idx;
        const active = currentIdx === idx;
        return (
          <li
            key={step}
            aria-current={active ? 'step' : undefined}
            style={{
              padding: '0.5rem 0.75rem',
              borderRadius: '0.375rem',
              border: '1px solid var(--tc-border-color, #d4d4d8)',
              background: active
                ? 'var(--tc-accent-bg, #e0f2fe)'
                : completed
                  ? 'var(--tc-success-bg, #ecfdf5)'
                  : 'transparent',
              fontWeight: active ? 600 : 400,
              fontSize: '0.875rem',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: '1.5rem',
                textAlign: 'center',
                marginRight: '0.25rem',
              }}
            >
              {completed ? '✓' : idx + 1}
            </span>
            {SUBMITTAL_STATE_LABELS[step]}
          </li>
        );
      })}
    </ol>
  );
}
