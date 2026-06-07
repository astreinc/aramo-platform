import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
}

export function PageHeader({ title, description }: PageHeaderProps) {
  return (
    <header className="tc-page-header">
      <h1 className="tc-page-header__title">{title}</h1>
      {description !== undefined && (
        <p className="tc-page-header__description">{description}</p>
      )}
    </header>
  );
}
