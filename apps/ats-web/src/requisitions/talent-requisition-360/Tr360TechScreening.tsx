import { Button, Input, TextArea } from '@aramo/fe-foundation';
import { useState } from 'react';

// Talent × Requisition 360 → Technical Screening (§5). PRESENTATION ONLY.
//
// The INC-3 screening scope expansion (LLM-drafted questions, Teams recording +
// transcript, Assist follow-ups) is NOT authorized under the current LOCKED
// directive, so nothing here calls a backend: no LLM, recording, transcript or
// CI request is wired. The full layout renders only when the `techScreening360`
// flag is ON *and* a session model is supplied; production supplies none, so the
// tab shows the empty state. No output here can change stage or ordering, qualify,
// reject or submit — "Mark qualified" stays the recruiter's header decision.

export type ScreeningPhase = 'prepared' | 'scheduled' | 'live' | 'findings' | 'saved';
export type ScreeningSource = 'REQ' | 'Client' | 'Résumé' | 'Transcript';
export type ScreeningLevel = 'Strong' | 'Moderate' | 'Limited' | 'Not demonstrated';
export type ScreeningConsent = 'pending' | 'yes' | 'no' | 'off';

export interface ScreeningQuestion {
  readonly id: string;
  readonly skill: string;
  readonly text: string;
  readonly why: string;
  readonly sources: readonly ScreeningSource[];
  readonly must: boolean;
  readonly follow?: boolean;
}

export interface ScreeningSuggestion {
  readonly id: string;
  readonly text: string;
  readonly why: string;
}

export interface ScreeningEvidence {
  readonly label: string;
  readonly kind: 'recruiter' | 'transcript' | 'document';
  readonly tip: string;
}

export interface ScreeningSessionModel {
  readonly phase: ScreeningPhase;
  readonly bannerTitle: string;
  readonly bannerSub: string;
  readonly consent: ScreeningConsent;
  readonly recording: boolean;
  readonly recordingLabel?: string;
  readonly questions: readonly ScreeningQuestion[];
  readonly asked: Readonly<Record<string, boolean>>;
  readonly levels: Readonly<Record<string, ScreeningLevel>>;
  readonly notes: Readonly<Record<string, string>>;
  readonly suggestions: Readonly<Record<string, readonly ScreeningSuggestion[]>>;
  readonly evidence: Readonly<Record<string, readonly ScreeningEvidence[]>>;
  readonly coverage: readonly { readonly skill: string; readonly count: number }[];
  readonly overall: ScreeningLevel | null;
  readonly summary: string;
}

const LEVELS: readonly { label: ScreeningLevel; desc: string; tone: 'green' | 'blue' | 'amber' | 'red' }[] = [
  { label: 'Strong', desc: 'Demonstrated deep knowledge and practical experience', tone: 'green' },
  { label: 'Moderate', desc: 'Demonstrated basic knowledge with some experience', tone: 'blue' },
  { label: 'Limited', desc: 'Some familiarity but limited hands-on experience', tone: 'amber' },
  { label: 'Not demonstrated', desc: 'Could not demonstrate the required knowledge or experience', tone: 'red' },
];

const SOURCE_TONE: Record<ScreeningSource, 'blue' | 'grey' | 'green'> = {
  REQ: 'blue',
  Client: 'blue',
  'Résumé': 'grey',
  Transcript: 'green',
};

const PHASE_PILL: Record<ScreeningPhase, { label: string; tone: 'blue' | 'amber' | 'green' }> = {
  prepared: { label: 'Prepared', tone: 'blue' },
  scheduled: { label: 'Scheduled', tone: 'blue' },
  live: { label: 'In progress', tone: 'amber' },
  findings: { label: 'Findings due', tone: 'amber' },
  saved: { label: 'Complete', tone: 'green' },
};

export function screeningStatusPill(
  session: ScreeningSessionModel | null,
): { label: string; tone: 'blue' | 'amber' | 'green' } | null {
  return session === null ? null : PHASE_PILL[session.phase];
}

export interface Tr360TechScreeningProps {
  readonly enabled: boolean;
  readonly session: ScreeningSessionModel | null;
  readonly talentFirstName: string;
  readonly reqCode: string;
}

function CalendarGlyph(): JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h16v14H4zM8 3v4M16 3v4M4 10h16" />
    </svg>
  );
}

function EmptyState({ enabled, talentFirstName }: { enabled: boolean; talentFirstName: string }): JSX.Element {
  return (
    <div className="tr360-ts__empty" data-testid="tr360-screening-empty">
      <div className="tr360-ts__empty-title">No technical screening yet</div>
      {enabled ? (
        <div className="tr360-ts__empty-body">
          Aramo will draft questions from the requisition, the client&apos;s must-haves and{' '}
          {talentFirstName}&apos;s résumé; you review, edit, schedule on Teams and run the call.
        </div>
      ) : null}
      {/* "Prepare screening" is hidden: preparing a screening is not wired in this increment. */}
    </div>
  );
}

export function Tr360TechScreening({
  enabled,
  session,
  talentFirstName,
  reqCode,
}: Tr360TechScreeningProps): JSX.Element {
  if (!enabled) {
    return (
      <div className="tr360-card tr360-ts" data-testid="tr360-screening">
        <EmptyState enabled={false} talentFirstName={talentFirstName} />
      </div>
    );
  }
  return (
    <div className="tr360-card tr360-ts" data-testid="tr360-screening">
      <div className="tr360-ts__hd">
        <span className="tr360-ts__hdtext">
          <span className="tr360-ts__title">Technical Screening</span>
          <span className="tr360-ts__sub">
            Run and record a structured technical conversation with {talentFirstName} for {reqCode}.
            Aramo drafts; you decide.
          </span>
        </span>
        <span className="tr360-ts__btns">
          <Button unstyled type="button" className="tr360-btn tr360-btn--brand-text">
            View guidelines
          </Button>
          <Button unstyled type="button" className="tr360-btn">
            Screening history
          </Button>
          <Button
            unstyled
            type="button"
            className="tr360-btn tr360-btn--brand"
            disabled={session !== null}
            style={{ opacity: session !== null ? 0.5 : 1 }}
          >
            + New screening
          </Button>
        </span>
      </div>
      {session === null ? (
        <EmptyState enabled talentFirstName={talentFirstName} />
      ) : (
        <ScreeningSessionView session={session} talentFirstName={talentFirstName} />
      )}
    </div>
  );
}

function ScreeningSessionView({
  session,
  talentFirstName,
}: {
  session: ScreeningSessionModel;
  talentFirstName: string;
}): JSX.Element {
  const [cur, setCur] = useState(0);
  const [editing, setEditing] = useState(false);
  const [assist, setAssist] = useState(true);
  const [asked, setAsked] = useState<Record<string, boolean>>({ ...session.asked });
  const [levels, setLevels] = useState<Record<string, ScreeningLevel>>({ ...session.levels });
  const [notes, setNotes] = useState<Record<string, string>>({ ...session.notes });
  const [overall, setOverall] = useState<ScreeningLevel | null>(session.overall);
  const [summary, setSummary] = useState(session.summary);
  const [newQ, setNewQ] = useState('');

  const { phase } = session;
  const questions = session.questions;
  const qCount = questions.length;
  const q = questions[Math.min(cur, qCount - 1)] ?? questions[0];
  const askedCount = Object.values(asked).filter(Boolean).length;
  const isPrepared = phase === 'prepared';
  const inCall = phase === 'live' || phase === 'findings' || phase === 'saved';
  const pill = PHASE_PILL[phase];
  const saved = phase === 'saved';
  const saveDisabled = overall === null || summary.trim().length < 20 || saved || !inCall;
  const lvl = q !== undefined ? levels[q.id] : undefined;
  const recLabel =
    session.recordingLabel ??
    (session.recording
      ? phase === 'live'
        ? 'Recording · consented'
        : 'Recorded · consented'
      : session.consent === 'no'
        ? 'Not recorded · declined'
        : session.consent === 'off'
          ? 'Not recording'
          : phase === 'live'
            ? 'Consent pending'
            : 'Recording requested');
  const suggestions = q !== undefined && session.recording && assist ? (session.suggestions[q.id] ?? []) : [];
  const evidence = q !== undefined ? (session.evidence[q.id] ?? []) : [];

  return (
    <>
      <div className="tr360-ts__banner" data-testid="tr360-screening-banner">
        <span className="tr360-ts__tile">
          <CalendarGlyph />
        </span>
        <span className="tr360-ts__btext">
          <span className="tr360-ts__btitle">{session.bannerTitle}</span>
          <span className="tr360-ts__bsub">{session.bannerSub}</span>
        </span>
        <span className="tr360-ts__bstate">
          <span className={`tr360-ts__status tr360-tone--${pill.tone}`}>{pill.label}</span>
          <span
            className={`tr360-ts__rec${session.recording ? ' tr360-ts__rec--on' : ''}${phase === 'live' ? ' tr360-ts__rec--live' : ''}`}
          >
            <span className="tr360-ts__recdot" aria-hidden="true" />
            {recLabel}
          </span>
          <span className="tr360-ts__count">
            {askedCount} of {qCount} questions
          </span>
          <span className="tr360-ts__bar" aria-hidden="true">
            <span className="tr360-ts__barfill" style={{ width: `${(askedCount / Math.max(1, qCount)) * 100}%` }} />
          </span>
          {isPrepared ? (
            <Button unstyled type="button" className="tr360-btn tr360-btn--brand tr360-btn--xs">
              Schedule on Teams
            </Button>
          ) : null}
          {phase === 'scheduled' ? (
            <Button unstyled type="button" className="tr360-btn tr360-btn--teams tr360-btn--xs">
              Join Teams call
            </Button>
          ) : null}
          {phase === 'live' ? (
            <Button unstyled type="button" className="tr360-btn tr360-btn--danger-outline tr360-btn--xs">
              End call
            </Button>
          ) : null}
        </span>
      </div>

      {phase === 'live' && session.consent === 'pending' && !session.recording ? (
        <div className="tr360-ts__consent">
          <span className="tr360-ts__consent-text">
            <b>Recording consent</b> · Ask {talentFirstName}: &quot;This call may be recorded and transcribed to
            support my notes; is that okay?&quot; Record the answer — nothing records until you do.
          </span>
          <Button unstyled type="button" className="tr360-btn tr360-btn--brand">
            {talentFirstName} agreed · start recording
          </Button>
          <Button unstyled type="button" className="tr360-btn">
            Declined · notes only
          </Button>
        </div>
      ) : null}

      <div className="tr360-ts__panes">
        <div className="tr360-ts__qlist">
          {questions.map((x, i) => {
            const isAsked = asked[x.id] === true;
            const on = i === cur;
            return (
              <Button
                unstyled
                key={x.id}
                type="button"
                className={`tr360-ts__q${on ? ' tr360-ts__q--on' : ''}${isAsked ? ' tr360-ts__q--asked' : ''}`}
                onClick={() => {
                  setCur(i);
                  setEditing(false);
                }}
              >
                <span className="tr360-ts__qdot">{isAsked ? '✓' : String(i + 1)}</span>
                <span className="tr360-ts__qtext">
                  <span className="tr360-ts__qskill">{x.skill}</span>
                  <span className="tr360-ts__qmeta">
                    {x.must ? 'Must-ask' : x.follow === true ? 'Follow-up' : 'Optional'}
                    {levels[x.id] !== undefined ? ` · ${levels[x.id]}` : ''}
                  </span>
                </span>
              </Button>
            );
          })}
          {isPrepared ? (
            <div className="tr360-ts__add">
              <Input unstyled className="tr360-ts__addq" value={newQ} onChange={(e) => setNewQ(e.target.value)} placeholder="Add your own question…" />
              <Button unstyled type="button" className="tr360-btn">
                Add
              </Button>
            </div>
          ) : null}
        </div>

        {q !== undefined ? (
          <div className="tr360-ts__cur">
            <div className="tr360-ts__curhd">
              <span className="tr360-ts__curtext">
                <span className="tr360-ts__curskill">
                  {cur + 1}. {q.skill}
                </span>
                <span className="tr360-ts__curwhy">{q.why}</span>
              </span>
              <span className="tr360-ts__nav">
                <Button unstyled type="button" className="tr360-btn" onClick={() => setCur((c) => Math.max(0, c - 1))}>
                  ‹ Previous
                </Button>
                <Button unstyled type="button" className="tr360-btn" onClick={() => setCur((c) => Math.min(qCount - 1, c + 1))}>
                  Next ›
                </Button>
              </span>
            </div>
            <div className="tr360-ts__qbox">
              <div className="tr360-ts__qboxhd">
                <span className="tr360-ts__label tr360-ts__label--brand">QUESTION</span>
                {q.sources.map((s) => (
                  <span key={s} className={`tr360-ts__src tr360-tone--${SOURCE_TONE[s]}`}>
                    {s}
                  </span>
                ))}
                {isPrepared ? (
                  <Button unstyled type="button" className="tr360-ts__edit" onClick={() => setEditing((e) => !e)}>
                    {editing ? 'Done' : 'Edit'}
                  </Button>
                ) : null}
              </div>
              {editing ? (
                <TextArea unstyled className="tr360-ts__qedit" rows={3} defaultValue={q.text} />
              ) : (
                <div className="tr360-ts__qread">{q.text}</div>
              )}
            </div>

            {inCall ? (
              <>
                <div className="tr360-ts__noteshd">
                  <span className="tr360-ts__label">INTERVIEWER NOTES</span>
                  <span className="tr360-ts__attest">· recruiter-attested</span>
                  <Button
                    unstyled
                    type="button"
                    className={`tr360-ts__asked${asked[q.id] === true ? ' tr360-ts__asked--on' : ''}`}
                    onClick={() => setAsked((a) => ({ ...a, [q.id]: !(a[q.id] === true) }))}
                  >
                    {asked[q.id] === true ? '✓ Asked' : 'Mark as asked'}
                  </Button>
                </div>
                <TextArea
                  unstyled
                  className="tr360-ts__notes"
                  rows={5}
                  value={notes[q.id] ?? ''}
                  onChange={(e) => setNotes((n) => ({ ...n, [q.id]: e.target.value.slice(0, 2000) }))}
                  placeholder={`What ${talentFirstName} said, in your words. Transcript snippets you pin appear as separate evidence.`}
                />
                <div className="tr360-ts__counter">{(notes[q.id] ?? '').length}/2000</div>
                <div className="tr360-ts__scalehd">
                  TECHNICAL ASSESSMENT <span>· {lvl !== undefined ? 'recorded' : 'pick after the answer'}</span>
                </div>
                <div className="tr360-ts__scale" role="radiogroup" aria-label="Technical assessment">
                  {LEVELS.map((l) => {
                    const on = lvl === l.label;
                    return (
                      <Button
                        unstyled
                        key={l.label}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        className={`tr360-ts__lvl${on ? ` tr360-lvl--${l.tone} tr360-ts__lvl--on` : ''}`}
                        onClick={() => setLevels((m) => ({ ...m, [q.id]: l.label }))}
                      >
                        <span className="tr360-ts__radio">
                          <span />
                        </span>
                        <span>
                          <span className="tr360-ts__lvlname">{l.label}</span>
                          <span className="tr360-ts__lvldesc">{l.desc}</span>
                        </span>
                      </Button>
                    );
                  })}
                </div>
              </>
            ) : null}

            {isPrepared ? (
              <>
                <div className="tr360-ts__prep">
                  <Button
                    unstyled
                    type="button"
                    className={`tr360-btn ${q.must ? 'tr360-ts__must--on' : 'tr360-ts__must--off'}`}
                  >
                    {q.must ? 'Must-ask' : 'Optional'}
                  </Button>
                  <Button unstyled type="button" className="tr360-btn tr360-btn--danger-text">
                    Remove
                  </Button>
                  <Button unstyled type="button" className="tr360-btn tr360-ts__regen">
                    Re-draft suggestions
                  </Button>
                </div>
                <div className="tr360-ts__cov">
                  <div className="tr360-ts__label" style={{ marginBottom: 8 }}>
                    COVERAGE OF CLIENT MUST-HAVES
                  </div>
                  {session.coverage.map((c) => (
                    <div key={c.skill} className="tr360-ts__covrow">
                      <span>{c.skill}</span>
                      <span className="tr360-ts__covbar">
                        <span
                          className="tr360-ts__covfill"
                          style={{ width: `${Math.min(100, c.count * 50)}%`, background: c.count > 0 ? '#022AC0' : '#C0410C' }}
                        />
                      </span>
                      <span className="tr360-ts__covn">
                        {c.count > 0 ? `${c.count} question${c.count > 1 ? 's' : ''}` : 'none'}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        <div className="tr360-ts__rail">
          <div className="tr360-ts__box">
            <div className="tr360-ts__boxhd">
              <span className="tr360-ts__boxtitle">Supporting evidence ({evidence.length})</span>
              <Button unstyled type="button" className="tr360-ts__mini">
                + Add
              </Button>
            </div>
            {evidence.map((e) => (
              <div key={e.label} className="tr360-ts__ev">
                <span className={`tr360-ts__evdot tr360-ts__evdot--${e.kind}`} title={e.tip} />
                <span className="tr360-rowtext">
                  <span className="tr360-ts__evlabel">{e.label}</span>
                  <span className="tr360-ts__evtip">{e.tip}</span>
                </span>
              </div>
            ))}
          </div>
          <div className="tr360-ts__box">
            <div className="tr360-ts__boxhd" style={{ marginBottom: 6 }}>
              <span className="tr360-ts__boxtitle">Suggested follow-ups</span>
              <span className="tr360-ts__assist">Assist</span>
              <Button unstyled type="button" className="tr360-ts__toggle" onClick={() => setAssist((a) => !a)}>
                {assist ? 'Turn off' : 'Turn on'}
              </Button>
            </div>
            {!assist ? <div className="tr360-ts__muted">Assistance is off for this call. Logged.</div> : null}
            {!session.recording ? (
              <div className="tr360-ts__muted">
                Follow-ups appear here from {talentFirstName}&apos;s answers once a consented recording is running.
                Without recording, you can still add questions by hand.
              </div>
            ) : null}
            {suggestions.map((sg) => (
              <div key={sg.id} className="tr360-ts__sg">
                <div className="tr360-ts__sgtext">{sg.text}</div>
                <div className="tr360-ts__sgwhy">Why: {sg.why}</div>
                <div className="tr360-ts__sgbtns">
                  <Button unstyled type="button" className="tr360-btn tr360-btn--brand">
                    Ask next
                  </Button>
                  <Button unstyled type="button" className="tr360-btn">
                    Dismiss
                  </Button>
                </div>
              </div>
            ))}
            {assist && session.recording && suggestions.length === 0 ? (
              <div className="tr360-ts__muted" style={{ borderTop: '1px solid #F2F4F6', paddingTop: 8 }}>
                No follow-ups for this question yet.
              </div>
            ) : null}
          </div>
          <div className="tr360-ts__box tr360-ts__box--final">
            <div className="tr360-ts__boxtitle" style={{ marginBottom: 8 }}>
              Final outcome <span>· after all questions</span>
            </div>
            <div className="tr360-ts__flabel">Overall assessment</div>
            <div className="tr360-ts__overall">
              {LEVELS.map((l) => (
                <Button
                  unstyled
                  key={l.label}
                  type="button"
                  className={`tr360-btn${overall === l.label ? ` tr360-lvl--${l.tone}` : ''}`}
                  onClick={() => setOverall(l.label)}
                >
                  {l.label}
                </Button>
              ))}
            </div>
            <div className="tr360-ts__flabel">Summary</div>
            <TextArea
              unstyled
              className="tr360-ts__summary"
              rows={4}
              value={summary}
              onChange={(e) => setSummary(e.target.value.slice(0, 1000))}
              placeholder="Key strengths, concerns and what the client should probe."
            />
            <div className="tr360-ts__counter">{summary.length}/1000</div>
            <div className="tr360-ts__save">
              <Button
                unstyled
                type="button"
                className="tr360-btn tr360-btn--brand"
                disabled={saveDisabled}
                style={{ opacity: saveDisabled ? 0.55 : 1 }}
              >
                {saved ? 'Findings recorded' : 'Complete screening'}
              </Button>
              <Button unstyled type="button" className="tr360-btn tr360-btn--danger-text">
                Cancel
              </Button>
            </div>
            <div className="tr360-ts__foot">
              Saved as recruiter-attested findings. Aramo never qualifies, rejects or ranks — &quot;Mark qualified&quot;
              in the header stays your decision.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
