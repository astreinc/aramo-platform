// M365-SCHED-1 visual-regression harness — PRODUCTION component renderer.
//
// Mounts the ACTUAL production React components (ScheduleMeetingDialog,
// MicrosoftRecruiterActions, UpcomingMeetings) with the real ATS Web styles
// (ui.css), the real fe-foundation components, and a router provider — NO simplified
// lookalikes. Collaborators are deterministic fixtures (no auth, no backend), so the
// harness renders the true component CSS/DOM for pixel comparison against the
// canonical prototype fragment. Retained as a reusable visual-regression surface.
//
// URL: /visual/harness/index.html?state=dialog|card|upcoming|cancel

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@aramo/fe-foundation';

import '../../src/ui/ui.css';
import { ScheduleMeetingDialog } from '../../src/microsoft/ScheduleMeetingDialog';
import { MicrosoftRecruiterActions } from '../../src/microsoft/MicrosoftRecruiterActions';
import { UpcomingMeetings } from '../../src/microsoft/UpcomingMeetings';
import type { ScheduledMeetingView } from '../../src/microsoft/microsoft-api';

const TALENT = 'Divya Vasudevan';
const noop = (): void => undefined;
const never = (): Promise<never> => new Promise<never>(() => undefined); // never resolves (stable render)

const MEETING: ScheduledMeetingView = {
  interaction_id: 'm1', operation_id: null, provider_event_id: 'evt-1',
  join_url: 'https://teams.example/join', status: 'scheduled', version: 1,
  scheduled_start: '2026-10-14T14:30:00.000Z', scheduled_end: '2026-10-14T15:00:00.000Z',
  idempotent_replay: false,
};

const params = new URLSearchParams(window.location.search);
const state = params.get('state') ?? 'dialog';

function Harness(): JSX.Element {
  if (state === 'card') {
    return (
      <div style={{ maxWidth: 520, margin: '40px auto', padding: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.07em', textTransform: 'uppercase', color: '#93A0A8', marginBottom: 9 }}>Microsoft 365</div>
        <MicrosoftRecruiterActions
          talentId="t1" talentName={TALENT} requisitionId="r1" pipelineId="p1"
          canSendEmail canScheduleMeeting canReadMeetings={false}
          loadStatusFn={() => Promise.resolve({ connection_id: 'c1', bound: true, status: 'active', needs_reauthorization: false })}
        />
      </div>
    );
  }
  if (state === 'upcoming') {
    return (
      <div style={{ maxWidth: 520, margin: '40px auto', padding: 16 }}>
        <UpcomingMeetings
          talentId="t1" talentName={TALENT} requisitionId="r1" canEdit canCancel
          listFn={() => Promise.resolve({ meetings: [MEETING] })}
          cancelFn={never} onReschedule={noop}
        />
      </div>
    );
  }
  // default: the schedule dialog (create) — deterministic fixtures matching the canonical
  return (
    <ScheduleMeetingDialog
      open onOpenChange={noop}
      talentId="t1" talentName={TALENT} talentEmail="vasudevandivya@gmail.com"
      requisitionId="r1" pipelineId="p1"
      requisitionReference="REQ-1000" requisitionTitle="Business Analyst - Multi-Family"
      organizerName="Purush Pichaimuthu" organizerEmail="purush@astreconsulting.com"
      defaultDate="2026-10-14" defaultTime="10:30"
      scheduleFn={never} onDone={noop}
    />
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <MemoryRouter><ToastProvider>
      <Harness />
    </ToastProvider></MemoryRouter>
  </StrictMode>,
);
