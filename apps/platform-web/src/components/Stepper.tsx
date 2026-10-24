import './platform-components.css';

// PLATFORM-UX-1 F-1 — the stepper (handoff §6.2): pills with a 22px circle.
// Current: midnight fill. Done: #E3F1EA with ✓. To do: grey. Colour is never the
// only cue: done steps show ✓ plus hidden "completed" text, the current step
// carries aria-current="step".

export interface StepperProps {
  /** Step labels, in order. */
  readonly steps: readonly string[];
  /** The current step, 1-based. */
  readonly current: number;
  /** The list's accessible name. Default: "Steps". */
  readonly label?: string;
}

export function Stepper({ steps, current, label = 'Steps' }: StepperProps) {
  return (
    <ol aria-label={label} className="pw-stepper">
      {steps.map((l, i) => {
        const n = i + 1;
        const state = n === current ? 'current' : n < current ? 'done' : 'todo';
        return (
          <li
            key={l}
            className={`pw-stepper__step pw-stepper__step--${state}`}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="pw-stepper__num" aria-hidden="true">
              {state === 'done' ? '✓' : n}
            </span>
            {l}
            {state === 'done' ? <span className="pw-sr-only"> (completed)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
