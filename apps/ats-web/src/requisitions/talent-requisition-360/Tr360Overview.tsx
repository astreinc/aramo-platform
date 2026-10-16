import { Button } from '@aramo/fe-foundation';
import type { ReactNode } from 'react';

import { channelLabel } from '../../talent-360/t360-vocab';
import type { AttentionItemView, RecentActivityItemView } from '../../talent-360/talent-360-types';

import { formatActivityTime, type PillTone, type SkillChip } from './tr360-model';

// Talent × Requisition 360 → Overview tab (§4). Pure presentation over facts the
// page already loaded from their owning reads; no derivation of attention,
// readiness or eligibility happens here.

export interface QualRow {
  readonly key: string;
  readonly label: string;
  readonly sub: string;
  readonly done: boolean;
  readonly glyph: string;
  readonly pill: string;
  readonly tone: PillTone;
  readonly cta: string | null;
  readonly ctaPrimary: boolean;
  readonly onCta?: () => void;
}

export interface RecruiterFact {
  readonly k: string;
  readonly v: string;
  readonly green?: boolean;
}

export interface Tr360OverviewProps {
  readonly talentFirstName: string;
  readonly reqCode: string;
  readonly attention: readonly AttentionItemView[];
  readonly onAttention: (item: AttentionItemView) => void;
  readonly qualRows: readonly QualRow[];
  readonly activity: readonly RecentActivityItemView[];
  readonly facts: readonly RecruiterFact[];
  readonly m365: ReactNode;
  readonly skills: readonly SkillChip[];
}

export function Tr360Overview({
  talentFirstName,
  reqCode,
  attention,
  onAttention,
  qualRows,
  activity,
  facts,
  m365,
  skills,
}: Tr360OverviewProps): JSX.Element {
  return (
    <>
      {attention.length > 0 ? (
        <div className="tr360-card tr360-attn" data-testid="tr360-attention">
          <div className="tr360-attn__hd">
            <span className="tr360-card__title">Needs attention</span>
            <span className="tr360-card__note">
              Same facts as My Desk, scoped to {talentFirstName} on {reqCode} · clears when resolved
            </span>
          </div>
          {attention.map((a) => (
            <div key={a.id} className="tr360-attn__row">
              <span className="tr360-attn__dot" aria-hidden="true" />
              <span className="tr360-rowtext">
                <span className="tr360-rowtext__what">{a.title}</span>
                {a.subtitle !== null ? <span className="tr360-rowtext__why">{a.subtitle}</span> : null}
              </span>
              {a.action !== null ? (
                <Button unstyled type="button" className="tr360-btn tr360-btn--brand tr360-btn--xs" onClick={() => onAttention(a)}>
                  {a.action.label}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="tr360-grid">
        <div className="tr360-col tr360-col--wide">
          <div className="tr360-card tr360-qual" data-testid="tr360-qualifying">
            <div className="tr360-qual__hd">
              <span className="tr360-card__title">Qualifying · what has to be true</span>
              <span className="tr360-card__note">Qualified is your decision; these are the evidence items behind it</span>
            </div>
            {qualRows.map((r) => (
              <div key={r.key} className="tr360-qual__row">
                <span className={`tr360-qual__glyph tr360-tone--${r.done ? 'green' : 'blue'}`} aria-hidden="true">
                  {r.glyph}
                </span>
                <span className="tr360-rowtext">
                  <span className="tr360-rowtext__what">{r.label}</span>
                  <span className="tr360-rowtext__why">{r.sub}</span>
                </span>
                <span className={`tr360-pill tr360-tone--${r.tone}`}>{r.pill}</span>
                {r.cta !== null && r.onCta !== undefined ? (
                  <Button
                    unstyled
                    type="button"
                    className={`tr360-btn tr360-btn--sm${r.ctaPrimary ? ' tr360-btn--brand' : ''}`}
                    onClick={r.onCta}
                  >
                    {r.cta}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>

          <div className="tr360-card tr360-card--pad" data-testid="tr360-activity">
            <div className="tr360-act__title">Activity on this requisition</div>
            {activity.length === 0 ? (
              <div className="tr360-empty">No activity on this requisition yet.</div>
            ) : (
              activity.map((a) => (
                <div key={a.id} className="tr360-act__row">
                  <span className="tr360-act__t">{formatActivityTime(a.occurred_at)}</span>
                  <span>
                    <b className="tr360-act__e">{a.title}</b>
                    {a.actor_label !== null ? <span className="tr360-act__who"> · {a.actor_label}</span> : null}
                  </span>
                  {a.channel !== null ? <span className="tr360-act__tag">{channelLabel(a.channel)}</span> : <span />}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="tr360-col">
          <div className="tr360-card tr360-card--pad" data-testid="tr360-recruiter-view">
            <div className="tr360-act__title">Recruiter view</div>
            <div className="tr360-facts">
              {facts.map((f) => (
                <div key={f.k} className="tr360-fact">
                  <div className="tr360-fact__k">{f.k}</div>
                  <div className={`tr360-fact__v${f.green === true ? ' tr360-fact__v--green' : ''}`}>{f.v}</div>
                </div>
              ))}
            </div>
          </div>
          {m365}
          <div className="tr360-card tr360-card--pad" data-testid="tr360-skills">
            <div className="tr360-skills__title">Requisition skills</div>
            {skills.length === 0 ? (
              <div className="tr360-empty">No skills on this requisition&apos;s profile yet.</div>
            ) : (
              <div className="tr360-skills">
                {skills.map((k) => (
                  <span key={k.label} className={`tr360-skill${k.must ? ' tr360-skill--must' : ''}`}>
                    {k.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
