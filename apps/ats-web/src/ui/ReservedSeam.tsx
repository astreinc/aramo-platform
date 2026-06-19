import type { ReactNode } from 'react';

import { IconClock, IconLogo } from './icons';

interface ReservedSeamProps {
  readonly title?: string;
  /** The ghosted explanatory copy. */
  readonly children?: ReactNode;
  /** The "integrates later" pill text. */
  readonly tag?: string;
}

// A ghosted, dashed placeholder for a future Core integration. THIS IS THE
// R10 GUARDRAIL SURFACE: the "Match insight" panel is a RESERVED SEAM ONLY —
// no scores, no tiers, no ranking. It states that evidence-ranked talent
// integrate with Core later, and renders nothing computable.
export function ReservedSeam({
  title = 'Match insight',
  children = 'Evidence-ranked talent from Aramo Core surface here — tiers and reasoning, no scores.',
  tag = 'Integrates with Core later',
}: ReservedSeamProps) {
  return (
    <section className="rc-seam" aria-label={title}>
      <h3 className="rc-seam__title">{title}</h3>
      <div className="rc-seam__ghost">
        <div className="rc-seam__ic" aria-hidden="true">
          <IconLogo />
        </div>
        <p>{children}</p>
      </div>
      <span className="rc-seam__tag">
        <IconClock />
        {tag}
      </span>
    </section>
  );
}
