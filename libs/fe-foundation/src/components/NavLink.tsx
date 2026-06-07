import type { ReactNode } from 'react';
import { NavLink as RouterNavLink } from 'react-router-dom';

interface NavLinkProps {
  to: string;
  children: ReactNode;
  end?: boolean;
}

export function NavLink({ to, end, children }: NavLinkProps) {
  return (
    <RouterNavLink to={to} end={end} className="tc-nav-link">
      <span aria-hidden="true" className="tc-nav-link__marker" />
      <span>{children}</span>
    </RouterNavLink>
  );
}
