import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Dialog } from '@aramo/fe-foundation';

import { Card, Icons, StatusPill } from '../ui';

import { discardTalentIntakeDraft, type TalentIntakeDraftListItem } from './talent-intake-api';
import { draftTitle, presentDraft } from './draft-recovery';

// Talent Draft Recovery (§5.1 + §18) — the In-progress recovery table: talent
// the recruiter started adding but hasn't created yet. Status/label/tone come
// ONLY from the shared presentDraft mapper. Continue resumes via the ?draft=
// deep link; the overflow menu offers Discard with the locked confirmation.

function startedLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `Today ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export interface InProgressTableProps {
  items: TalentIntakeDraftListItem[];
  onChanged: () => void;
}

export function InProgressTable({ items, onChanged }: InProgressTableProps): JSX.Element {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function doDiscard(): Promise<void> {
    if (confirm === null) return;
    setBusy(true);
    try {
      await discardTalentIntakeDraft(confirm.id);
      setConfirm(null);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="rc-sub">Talent you started adding but haven't created yet. Saved automatically.</p>
      {/* §20 — wide table (≥760px); the two-line narrow list below takes over <760px. */}
      <div className="rc-ip-wide">
      <Card flush>
        <div className="rc-tablewrap">
          <table className="rc-table">
            <thead>
              <tr>
                <th>Name / file</th>
                <th>Status</th>
                <th>Required</th>
                <th>Started</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {items.map((d) => {
                const p = presentDraft(d);
                const { title, file } = draftTitle(d);
                // total > 0 guard: a neutral 0/0 fallback must NOT read as complete (green).
                const reqComplete = p.requiredTotal > 0 && p.requiredMet >= p.requiredTotal;
                return (
                  <tr key={d.id} data-testid="in-progress-row">
                    <td>
                      <span className="rc-ip__name">{title}</span>
                      <span className="rc-ip__file">
                        <Icons.IconFile aria-hidden="true" /> {file}
                      </span>
                    </td>
                    <td>
                      <StatusPill tone={p.pillTone}>{p.label}</StatusPill>
                      {p.reason !== null ? <span className="rc-ip__reason">{p.reason}</span> : null}
                    </td>
                    <td>
                      <span className={reqComplete ? 'rc-ip__req rc-ip__req--ok' : 'rc-ip__req'}>
                        {p.requiredMet} of {p.requiredTotal}
                      </span>
                    </td>
                    <td>{startedLabel(d.created_at)}</td>
                    <td style={{ textAlign: 'right', position: 'relative' }}>
                      <Link
                        to={`/talent/new?draft=${encodeURIComponent(d.id)}&from=in-progress`}
                        className="rc-hbtn rc-hbtn--primary"
                      >
                        Continue
                      </Link>
                      <Button
                        unstyled
                        type="button"
                        className="rc-ip__more"
                        aria-label="More actions"
                        aria-haspopup="menu"
                        aria-expanded={menuFor === d.id}
                        onClick={() => setMenuFor((cur) => (cur === d.id ? null : d.id))}
                      >
                        ⋯
                      </Button>
                      {menuFor === d.id ? (
                        <div className="rc-ip__menu" role="menu">
                          <Button
                            unstyled
                            type="button"
                            role="menuitem"
                            className="rc-ip__menuitem rc-ip__menuitem--danger"
                            onClick={() => {
                              setMenuFor(null);
                              setConfirm({ id: d.id, name: title });
                            }}
                          >
                            Discard
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      </div>

      {/* §20 — two-line narrow rows: "Name · Status" then "file · age  Continue". */}
      <div className="rc-ip-narrow">
        {items.map((d) => {
          const p = presentDraft(d);
          const { title, file } = draftTitle(d);
          return (
            <div key={d.id} className="rc-ipn__row" data-testid="in-progress-row-narrow">
              <div className="rc-ipn__l1">
                <span className="rc-ipn__nm">{title}</span>
                <StatusPill tone={p.pillTone}>{p.label}</StatusPill>
              </div>
              <div className="rc-ipn__l2">
                <span className="rc-ipn__file">
                  {file} · {startedLabel(d.created_at)}
                </span>
                <Link
                  to={`/talent/new?draft=${encodeURIComponent(d.id)}&from=in-progress`}
                  className="rc-hbtn rc-hbtn--primary rc-ipn__cont"
                >
                  Continue
                </Link>
              </div>
            </div>
          );
        })}
      </div>
      <p className="rc-ip__foot">
        Only you can see talent you started adding. Nothing here is deleted automatically.
      </p>

      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
        }}
        title="Discard this unfinished talent?"
        description={
          confirm !== null
            ? `${confirm.name} — the uploaded résumé is deleted. This can't be undone.`
            : ''
        }
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>
              Keep
            </Button>
            <Button variant="primary" onClick={doDiscard} disabled={busy}>
              Discard
            </Button>
          </>
        }
      >
        <p className="rc-empty">This removes the draft and its uploaded résumé.</p>
      </Dialog>
    </>
  );
}
