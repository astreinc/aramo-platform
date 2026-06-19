import type { ReactNode } from 'react';

import { IconClock, IconInfo } from '../ui/icons';

// Settings Rebuild Directive 1 — shared section primitives.
//
// These render the mockup's section grammar (section head, status chips, the
// label/sublabel row, and THE honest seam) on the canonical Confident-Blue
// token layer. The seam is the load-bearing piece: a `SettingsSeam` is always
// visibly dashed and tagged "coming soon" / "on the roadmap" — it can never be
// mistaken for a live control. That is the no-dead-knobs invariant expressed
// in a component.

// ── Section head: title + description + optional right-aligned actions ──
export function SettingsSection({
  title,
  description,
  actions,
  children,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="set-content" aria-label={title}>
      <div className="set-head">
        <div>
          <h1>{title}</h1>
          {description != null ? <p>{description}</p> : null}
        </div>
        <div className="set-head__grow" />
        {actions != null ? (
          <div className="set-head__actions">{actions}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

// ── Status chip — read-only state, never a control ──
type ChipTone = 'ok' | 'warn' | 'info' | 'muted' | 'brand';

export function StatChip({
  tone = 'muted',
  dot = false,
  children,
}: {
  readonly tone?: ChipTone;
  readonly dot?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <span className={`set-chip set-chip--${tone}`}>
      {dot ? <span className="set-chip__d" /> : null}
      {children}
    </span>
  );
}

// ── The label/sublabel row with a right-aligned slot ──
export function SettingRow({
  title,
  sub,
  children,
}: {
  readonly title: ReactNode;
  readonly sub?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="set-row__l">
        <div className="set-row__t">{title}</div>
        {sub != null ? <div className="set-row__s">{sub}</div> : null}
      </div>
      {children != null ? <div className="set-row__r">{children}</div> : null}
    </div>
  );
}

// ── Card header with a leading section icon (matches the mockup `.ch`) ──
export function SettingCardHead({
  icon,
  title,
  sub,
}: {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly sub?: ReactNode;
}) {
  return (
    <div className="set-ch">
      {icon}
      <div>
        <h2>{title}</h2>
        {sub != null ? <p>{sub}</p> : null}
      </div>
    </div>
  );
}

// ── A small explanatory hint line under a card ──
export function SettingHint({ children }: { readonly children: ReactNode }) {
  return (
    <div className="set-hint">
      <IconInfo />
      <span>{children}</span>
    </div>
  );
}

// ── THE HONEST SEAM ──
//
// A clearly-marked "coming soon" / roadmap placeholder. `forbidden` flips the
// tag amber and is used ONLY for the refusal-layer-forbidden surfaces (Career
// portal, Apply flow) — the substrate does not exist AND the refusal layer
// forbids building it, so these are seams by mandate, never wired.
export function SettingsSeam({
  icon,
  title,
  tag,
  forbidden = false,
  children,
  vision,
}: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly tag?: string;
  readonly forbidden?: boolean;
  readonly children: ReactNode;
  /** Bulleted "what this will do" lines — the full vision, none of it live. */
  readonly vision?: readonly ReactNode[];
}) {
  const tagText = tag ?? (forbidden ? 'On the roadmap' : 'Coming soon');
  return (
    <div className="set-seam">
      <div className="set-seam__head">
        {icon}
        <h2>{title}</h2>
        <span
          className={`set-seam__tag${forbidden ? ' set-seam__tag--forbidden' : ''}`}
        >
          <IconClock />
          {tagText}
        </span>
      </div>
      <p>{children}</p>
      {vision != null && vision.length > 0 ? (
        <div className="set-seam__vision">
          {vision.map((v, i) => (
            <div className="set-seam__vrow" key={i}>
              <IconInfo />
              <span>{v}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
