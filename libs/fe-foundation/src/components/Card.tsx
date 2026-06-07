import type { ReactNode } from 'react';

interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

export function Card({ title, description, footer, children }: CardProps) {
  return (
    <section className="tc-card">
      {(title !== undefined || description !== undefined) && (
        <header className="tc-card__header">
          {title !== undefined && <h2 className="tc-card__title">{title}</h2>}
          {description !== undefined && (
            <p className="tc-card__description">{description}</p>
          )}
        </header>
      )}
      <div className="tc-card__body">{children}</div>
      {footer !== undefined && <div className="tc-card__footer">{footer}</div>}
    </section>
  );
}
