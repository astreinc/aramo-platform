import type { ReactNode } from 'react';

import { Pill, type PillSpec, type PlatformTone } from './Pill';
import { formatDate, formatRelative, formatTimestamp } from './format-date';
import './platform-components.css';

// PLATFORM-UX-1 F-1 — the audit timeline (handoff §6.3 Lifecycle & audit):
// newest first; a 10px dot in the target status tone (rejected = danger), the
// human label, from → to pills, "date · relative" on the right, the reason label
// plus its mono code, the actor type plus a short id (full id on hover), the
// mono UTC timestamp, and an optional note box. Raw event names and snake_case
// codes are never the label (handoff §5).

export interface TimelineEvent {
  readonly id: string;
  /** Human label ("Suspended"). */
  readonly label: string;
  /** ISO instant. */
  readonly at: string;
  /** The dot tone; `faint` (default) when the event changes no status. */
  readonly tone?: PlatformTone | 'faint';
  readonly from?: PillSpec | null;
  readonly to?: PillSpec | null;
  /** Reason: a human label plus the raw code (mono). */
  readonly reason?: { readonly label: string; readonly code: string } | null;
  /** Actor type label ("Operator") plus the full id (title) — shown shortened. */
  readonly actor: { readonly label: string; readonly id?: string | null };
  /** Free-text note, rendered in a box. */
  readonly note?: ReactNode;
}

export interface TimelineProps {
  readonly events: readonly TimelineEvent[];
  /** Relative-time reference (tests). Default: now. */
  readonly now?: Date;
}

/** "op_7f3a…" — the first 7 characters plus an ellipsis; short ids are kept whole. */
export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 7)}…` : id;
}

export function Timeline({ events, now }: TimelineProps) {
  return (
    <ol className="pw-timeline">
      {events.map((e) => (
        <li key={e.id} className="pw-timeline__item">
          <span className={`pw-timeline__dot pw-timeline__dot--${e.tone ?? 'faint'}`} aria-hidden="true" />
          <div className="pw-timeline__body">
            <div className="pw-timeline__head">
              <b className="pw-timeline__label">{e.label}</b>
              {e.from && e.to ? (
                <span className="pw-timeline__ft">
                  <Pill tone={e.from.tone} size="sm">
                    {e.from.label}
                  </Pill>
                  <span aria-hidden="true">→</span>
                  <span className="pw-sr-only"> to </span>
                  <Pill tone={e.to.tone} size="sm">
                    {e.to.label}
                  </Pill>
                </span>
              ) : null}
              <span className="pw-timeline__when">
                {formatDate(e.at)} · {formatRelative(e.at, now)}
              </span>
            </div>
            <div className="pw-timeline__meta">
              {e.reason ? (
                <span>
                  {e.reason.label} <span className="pw-timeline__code">{e.reason.code}</span>
                </span>
              ) : null}
              <span title={e.actor.id ?? undefined}>
                {e.actor.label}
                {e.actor.id ? (
                  <>
                    {' '}
                    <span className="pw-timeline__actor-id">{shortId(e.actor.id)}</span>
                  </>
                ) : null}
              </span>
              <span className="pw-timeline__ts">{formatTimestamp(e.at)}</span>
            </div>
            {e.note ? <div className="pw-timeline__note">{e.note}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
