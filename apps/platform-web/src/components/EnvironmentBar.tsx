import './platform-components.css';

// PLATFORM-UX-1 F-1 — the environment bar (handoff §3.2): a 30px terracotta
// strip, sticky on top of every console screen, that names the console and the
// signed-in identity so an operator can never mistake where they are or who
// they are signed in as.

export type EnvironmentContext = 'console' | 'studio' | 'commercial';

export interface EnvironmentBarProps {
  /** The signed-in email (or the session subject while /platform/me is unresolved). */
  readonly email: string;
  /** The signed-in tenant's name (or its id while unresolved). */
  readonly tenant: string;
  /** The role label ("Super admin"); omitted while unresolved. */
  readonly role?: string | null;
  /** The Studio and the Commercial screens swap the middle line (handoff §3.2). Default: console. */
  readonly context?: EnvironmentContext;
}

const CONTEXT_LINE: Readonly<Record<EnvironmentContext, string>> = {
  console: 'admin.aramo.ai · actions here apply across every tenant',
  studio: 'Template changes apply to every tenant that uses the default',
  // CCP-B1 — the Commercial screens (Commercial Control Plane v1.0.dc.html env bar).
  commercial: 'admin.aramo.ai · commercial changes need approval from other people',
};

export function EnvironmentBar({ email, tenant, role, context = 'console' }: EnvironmentBarProps) {
  return (
    // role="region" (not "banner"): the shell's top bar <header> is already the
    // page's banner landmark, and a page has one banner (axe
    // landmark-no-duplicate-banner). Deviation from the design file's
    // role=banner, recorded in H-1.
    <div role="region" aria-label="Platform environment" className="pw-envbar">
      <span className="pw-envbar__mark">
        <span className="pw-envbar__diamond" aria-hidden="true" />
        PLATFORM ADMIN
      </span>
      <span className="pw-envbar__context">{CONTEXT_LINE[context]}</span>
      <span className="pw-envbar__who" data-testid="envbar-identity">
        Signed in as <b>{email}</b> · {tenant}
        {role ? ` · ${role}` : null}
      </span>
    </div>
  );
}
