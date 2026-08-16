import { Card } from '@aramo/fe-foundation';

import {
  SELECTION_EVENT_TYPE_LABELS,
  SELECTION_STATE_LABELS,
  type ConversationStartedPayload,
  type SelectionEventView,
  type SelectionState,
  type OutreachDraftedPayload,
  type OutreachSentPayload,
  type ResponseReceivedPayload,
  type StateTransitionPayload,
} from './types';

// The selection event log (§4). Renders the 5 SelectionEventType, each
// narrowed on event_type with a per-type payload summary. The outreach
// text (draft_text / final_text) is persisted in the event log per the
// ADR-0015 addendum and rendered here. Pure presentational — the parent
// owns the fetch (the events also feed the response picker).

function stateLabel(s: SelectionState | null): string {
  return s === null ? 'created' : SELECTION_STATE_LABELS[s];
}

function eventSummary(event: SelectionEventView): string {
  switch (event.event_type) {
    case 'state_transition': {
      const p = event.event_payload as StateTransitionPayload;
      return `${stateLabel(p.from_state)} → ${stateLabel(p.to_state)}`;
    }
    case 'outreach_drafted': {
      const p = event.event_payload as OutreachDraftedPayload;
      return p.draft_text;
    }
    case 'outreach_sent': {
      const p = event.event_payload as OutreachSentPayload;
      return p.final_text;
    }
    case 'response_received': {
      const p = event.event_payload as ResponseReceivedPayload;
      return `Response received ${p.response_received_at}`;
    }
    case 'conversation_started': {
      const p = event.event_payload as ConversationStartedPayload;
      return `Conversation started ${p.conversation_started_at}`;
    }
    default:
      return '';
  }
}

// outreach_sent carries a back-reference to the source draft (the editable
// trail). Surface that the sent text may differ from the AI draft.
function editedTrailNote(event: SelectionEventView): string | null {
  if (event.event_type !== 'outreach_sent') return null;
  return 'Sent text (reviewed before send)';
}

export function EventLog({
  events,
}: {
  events: readonly SelectionEventView[];
}) {
  if (events.length === 0) {
    return <p>No selection events recorded yet.</p>;
  }
  return (
    <ul className="timeline">
      {events.map((event) => {
        const trail = editedTrailNote(event);
        return (
          <li key={event.id} className="timeline__item">
            <Card>
              <p className="selection-event__type">
                <strong>
                  {SELECTION_EVENT_TYPE_LABELS[event.event_type]}
                </strong>
              </p>
              <p className="selection-event__summary">
                {eventSummary(event)}
              </p>
              {trail !== null ? (
                <p className="selection-event__trail">{trail}</p>
              ) : null}
              <time dateTime={event.created_at}>{event.created_at}</time>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
