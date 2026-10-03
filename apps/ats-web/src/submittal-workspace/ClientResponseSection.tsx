import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '@aramo/fe-foundation';

import { Button, Card, StatusPill } from '../ui';

import {
  ClientSelectionActionDialog,
  ScheduleInterviewDialog,
  type ClientSelectionActionKind,
} from './ClientResponseDialogs';
import {
  clientSelectionPill,
  deliveryLabel,
  formatDate,
  formatDateTime,
  waitingLabel,
} from './present';
import type { SubmittalWorkspaceView } from './submittal-workspace-types';

// SW-6 — the client-response section (post-handoff): current ClientSelection state,
// waiting duration, latest feedback, governed outcome actions, interview summary +
// deep-link, and the event history. All state/feedback/actions come from the SW-4
// projection (ClientSelectionProcess authority) — this owns no client-response truth
// and never re-derives readiness, routing, or authorization. Kept visually distinct
// from the Submittal lifecycle (which lives in the header pill).

type OpenDialog = ClientSelectionActionKind | 'schedule' | null;

export function ClientResponseSection({ view, onChanged }: { view: SubmittalWorkspaceView; onChanged: () => void }) {
  const cs = view.client_selection;
  const toast = useToast();
  const [dialog, setDialog] = useState<OpenDialog>(null);

  const cPill = clientSelectionPill(cs.state);
  const waiting = waitingLabel(cs.opened_at);
  const a = cs.available_actions;
  const latestFeedback = cs.feedback[0] ?? null;
  const history = buildHistory(view);

  const afterChange = (message: string) => {
    toast.show(message);
    onChanged();
  };
  const onConflict = () => {
    toast.show('This client response changed — refreshing to the current status.');
    onChanged();
  };

  const nextRound = (cs.latest_interview?.round ?? 0) + 1;

  return (
    <Card className="sw-client">
      <div className="sw-client__head">
        <span className="sw-client__title">Client response</span>
        {cPill ? <StatusPill tone={cPill.tone} dot>{cPill.label}</StatusPill> : null}
        {waiting !== null && cs.state === 'CLIENT_REVIEW' ? (
          <span className="sw-client__age">In client review · {waiting}</span>
        ) : waiting !== null ? (
          <span className="sw-client__age">With the client · {waiting}</span>
        ) : null}
      </div>

      {/* Interview summary — reuse the existing Interview detail for management. */}
      {cs.latest_interview !== null ? (
        <div className="sw-client__interview">
          <div className="sw-client__interview-line">
            <b>Interview</b>
            <span>Round {cs.latest_interview.round} · {titleCaseState(cs.latest_interview.state)}{cs.latest_interview.scheduled_at ? ` · ${formatDateTime(cs.latest_interview.scheduled_at)}` : ''}</span>
          </div>
          <Link className="sw-link" to={`/interviews/${cs.latest_interview.id}`}>Open interview →</Link>
        </div>
      ) : null}

      {/* Latest process feedback (from the authoritative event stream). */}
      {latestFeedback !== null ? (
        <div className="sw-client__fb">
          <span className="sw-client__fb-k">LATEST FEEDBACK</span>
          <span className="sw-client__fb-note">{latestFeedback.note ?? latestFeedback.reason_code ?? '—'}</span>
          <span className="sw-client__fb-meta">{latestFeedback.to_state ? `${titleCaseState(latestFeedback.to_state)} · ` : ''}{formatDate(latestFeedback.at)}</span>
        </div>
      ) : (
        <div className="sw-client__nofb">No client feedback recorded yet.</div>
      )}

      {/* Governed outcome actions — rendered ONLY where the server-owned flag is true. */}
      {(a.can_move_to_interview || a.can_schedule_interview || a.can_mark_selected || a.can_decline || a.can_withdraw) ? (
        <div className="sw-client__actions">
          {a.can_move_to_interview ? <Button variant="secondary" type="button" onClick={() => setDialog('move_to_interview')}>Move to interview</Button> : null}
          {a.can_schedule_interview ? <Button variant="secondary" type="button" onClick={() => setDialog('schedule')}>Schedule interview</Button> : null}
          {a.can_mark_selected ? <Button variant="secondary" type="button" onClick={() => setDialog('mark_selected')}>Record selected</Button> : null}
          {a.can_decline ? <Button variant="secondary" type="button" onClick={() => setDialog('decline')}>Decline</Button> : null}
          {a.can_withdraw ? <Button variant="secondary" type="button" onClick={() => setDialog('withdraw')}>Withdraw</Button> : null}
        </div>
      ) : null}

      <div className="sw-client__hist-label">HISTORY</div>
      {history.length > 0 ? history.map((h, i) => (
        <div key={i} className="sw-client__hist">
          <span className="sw-mono">{h.date}</span>
          <span><b>{h.title}</b><span className="sw-client__hist-sub">{h.sub}</span></span>
        </div>
      )) : <div className="sw-client__nofb">No client events recorded yet.</div>}

      {/* Dialogs (governed; CAS via the projected version; conflict → refetch). */}
      {cs.process_id !== null && cs.version !== null ? (
        <>
          {dialog !== null && dialog !== 'schedule' ? (
            <ClientSelectionActionDialog
              open
              onOpenChange={(o) => { if (!o) setDialog(null); }}
              kind={dialog}
              processId={cs.process_id}
              version={cs.version}
              onDone={() => { setDialog(null); afterChange('Client response recorded.'); }}
              onConflict={() => { setDialog(null); onConflict(); }}
            />
          ) : null}
          <ScheduleInterviewDialog
            open={dialog === 'schedule'}
            onOpenChange={(o) => { if (!o) setDialog(null); }}
            processId={cs.process_id}
            defaultRound={nextRound}
            onDone={() => { setDialog(null); afterChange('Interview scheduled.'); }}
            onConflict={() => { setDialog(null); onConflict(); }}
          />
        </>
      ) : null}
    </Card>
  );
}

function titleCaseState(s: string): string {
  return s.toLowerCase().split('_').map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

// Client-response history composed from SW-4 facts only: the submitted-to-client
// milestone (delivery provenance) + the ClientSelection event feedback (newest first in
// SW-4, shown oldest→newest here). No invented status or taxonomy.
function buildHistory(view: SubmittalWorkspaceView): { date: string; title: string; sub: string }[] {
  const out: { date: string; title: string; sub: string }[] = [];
  if (view.delivery.submitted_at !== null) {
    out.push({ date: formatDate(view.delivery.submitted_at), title: 'Submitted to client', sub: deliveryLabel(view.delivery.delivery_channel) });
  }
  const events = view.client_selection.feedback.slice().reverse();
  for (const ev of events) {
    out.push({ date: formatDate(ev.at), title: ev.to_state ? titleCaseState(ev.to_state) : 'Client update', sub: ev.note ?? ev.reason_code ?? '' });
  }
  return out;
}
