import type { ReactNode } from 'react';

interface CardProps {
  /** Padded body (false) vs flush content like an edge-to-edge table (true). */
  readonly flush?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

// A bordered surface in the Confident Blue grammar (radius-lg, hairline
// border, single elevation). NEW (not the frozen Card): the frozen Card
// forces internal padding and a fixed title/description/footer slot layout,
// which cannot express the mockup's flush-table cards or custom header
// action rows. The frozen Card remains available (themed) for simple panels.
export function Card({ flush = false, className, children }: CardProps) {
  return (
    <div className={`rc-card${flush ? '' : ' rc-card--pad'}${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  );
}

interface CardHeadProps {
  readonly title: ReactNode;
  /** Right-aligned actions (e.g. a "View all" link or buttons). */
  readonly actions?: ReactNode;
}

export function CardHead({ title, actions }: CardHeadProps) {
  return (
    <div className="rc-card__head">
      <h2>{title}</h2>
      {actions != null ? (
        <div className="rc-card__head-actions">{actions}</div>
      ) : null}
    </div>
  );
}
