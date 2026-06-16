import { IconCheck } from './icons';

interface StepperProps {
  /** Ordered step labels (e.g. the engagement-state progression). */
  readonly steps: readonly string[];
  /** Index of the current step; earlier steps render as done. */
  readonly currentIndex: number;
}

// Vertical progress stepper — done / current / upcoming. Used for the
// engagement-state ladder. Pure projection of (steps, currentIndex); no
// domain coupling so it can render any ordered state machine.
export function Stepper({ steps, currentIndex }: StepperProps) {
  return (
    <ol className="rc-stepper">
      {steps.map((label, i) => {
        const phase = i < currentIndex ? 'done' : i === currentIndex ? 'cur' : 'upcoming';
        return (
          <li
            key={label}
            className={`rc-step${phase === 'done' ? ' rc-step--done' : ''}${
              phase === 'cur' ? ' rc-step--cur' : ''
            }`}
            aria-current={phase === 'cur' ? 'step' : undefined}
          >
            <span className="rc-step__d" aria-hidden="true">
              {phase === 'done' ? <IconCheck /> : null}
            </span>
            <span className="rc-step__lb">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
