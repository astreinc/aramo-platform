// Shared fixtures for the W5 feature tests (not a test file: no .test suffix).
import { createWorkspaceClient, type WorkspaceSessionPort } from '../../../api/workspaceClient';
import { recordingFetch, type Responder } from '../../../testing/fakes';
import type { InboxItem, SenderEnvelopeDetail, SenderListItem, EnvelopeStatus } from '../types';

export const BASE = 'https://sign.aramo.ai';
export const ACCESS = 'access.jwt.value';

export function testSession(): WorkspaceSessionPort {
  return {
    getAccessToken: async () => ACCESS,
    refreshAccessToken: async () => null,
    sessionExpired: jest.fn(),
  };
}

export function workspaceWith(responder: Responder) {
  const net = recordingFetch(responder);
  const workspace = createWorkspaceClient({
    baseUrl: BASE,
    fetch: net.fetch,
    session: testSession(),
  });
  return { net, workspace };
}

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

export function sent(status: EnvelopeStatus, over: Partial<SenderListItem> = {}): SenderListItem {
  return {
    id: uuid(),
    subject: `Sent ${status}`,
    status,
    created_at: '2026-10-01T10:00:00.000Z',
    sent_at: status === 'DRAFT' ? null : '2026-10-02T10:00:00.000Z',
    completed_at: null,
    last_activity_at: '2026-10-03T10:00:00.000Z',
    document_count: 1,
    source_application: 'aramo-sign',
    recipients: [
      { id: uuid(), name: 'Alex Morgan', email: 'alex@example.com', status: 'SIGNED' },
      { id: uuid(), name: 'Sam Lee', email: 'sam@example.com', status: 'PENDING' },
    ],
    ...over,
  };
}

export function received(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: uuid(),
    subject: 'Offer letter',
    from: 'Northwind Staffing',
    envelope_status: 'IN_PROGRESS',
    my_status: 'PENDING',
    sent_at: '2026-10-04T10:00:00.000Z',
    expires_at: '2026-11-03T10:00:00.000Z',
    envelope_expires_at: '2026-11-03T10:00:00.000Z',
    signing_link_valid_days: 7,
    completed_at: null,
    signed_at: null,
    can_sign: true,
    can_download: false,
    ...over,
  };
}

export function detail(over: Partial<SenderEnvelopeDetail> = {}): SenderEnvelopeDetail {
  return {
    id: 'e5000000-0000-4000-8000-0000000000a1',
    subject: 'MSA',
    status: 'IN_PROGRESS',
    editable: false,
    routing_mode: 'PARALLEL',
    next_signer_id: null,
    revision: 3,
    message: null,
    signing_link_valid_days: 7,
    envelope_expires_at: '2026-11-20T00:00:00.000Z',
    expires_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    sent_at: '2026-10-02T00:00:00.000Z',
    completed_at: null,
    declined_at: null,
    voided_at: null,
    sender: { id: 'user-1', name: 'Pat Sender' },
    source_application: 'aramo-sign',
    documents: [],
    recipients: [
      {
        id: 's1',
        name: 'Alex Morgan',
        email: 'alex@example.com',
        status: 'PENDING',
        signing_order: 1,
        viewed_at: null,
        signed_at: null,
        declined_at: null,
        decline_reason: null,
        can_remind: true,
        reminder_available_at: null,
      },
    ],
    fields: [],
    ...over,
  };
}

export const CTX_OWNER = {
  user: { id: 'user-1', email: 'pat@example.com', display_name: 'Pat Sender' },
  tenant: { id: 't1', name: 'Northwind', kind: 'BUSINESS' as const },
  workspace: 'sign' as const,
  permissions: { read: true, create: true, send: true, manage_all: false },
  can_send: true,
  personal_sending_enabled: false,
};
