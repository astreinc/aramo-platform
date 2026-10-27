import { ApiError } from '../../../api/errors';
import { allowanceModel, limitBanner } from '../../inbox/allowance';
import type { BillingAccount } from '../../inbox/types';
import { reviewWarnings } from '../reviewWarnings';
import type { EditorField } from '../../editor/editorReducer';

const doc = {
  key: 'd1',
  serverId: null,
  title: 'Offer',
  filename: 'Offer.pdf',
  pages: [{ width: 612, height: 792 }],
  pendingUpload: null,
};
const dana = { key: 'r1', serverId: null, name: 'Dana Lee', email: 'dana@example.com' };
const sam = { key: 'r2', serverId: null, name: 'Sam Roy', email: 'sam@example.com' };
const field = (recipientKey: string, type: EditorField['type']): EditorField => ({
  key: `${recipientKey}-${type}`,
  docKey: 'd1',
  page: 0,
  recipientKey,
  type,
  x: 0,
  y: 0,
  width: 100,
  height: 20,
  required: true,
});

describe('Before you send', () => {
  it('lists every blocking warning the backend enforces', () => {
    expect(
      reviewWarnings({ documents: [], recipients: [], fields: [] }, null, null).map((w) => w.text),
    ).toEqual(['Add a document.', 'Add at least one signer.']);
  });

  it('names each signer without a SIGNATURE field (other types do not count)', () => {
    const w = reviewWarnings(
      {
        documents: [doc],
        recipients: [dana, sam],
        fields: [field('r1', 'SIGNATURE'), field('r2', 'INITIALS'), field('r2', 'TEXT')],
      },
      null,
      null,
    );
    expect(w).toEqual([{ kind: 'no_signature_field', text: 'Sam Roy has no signature field.' }]);
  });

  it('is empty when the envelope is ready', () => {
    expect(
      reviewWarnings(
        { documents: [doc], recipients: [dana], fields: [field('r1', 'SIGNATURE')] },
        null,
        null,
      ),
    ).toEqual([]);
  });

  it('adds the Personal limit with the exact next-send time (C-3)', () => {
    const account = {
      tenant_kind: 'PERSONAL',
      allowance: {
        limit: 5,
        used: 2,
        remaining: 3,
        period_end: '2026-11-01T00:00:00.000Z',
        daily: {
          window: 'DAY',
          limit: 2,
          used: 2,
          remaining: 0,
          next_available_at: '2026-10-26T15:40:00.000Z',
        },
      },
    } as unknown as BillingAccount;
    const banner = limitBanner(allowanceModel(account));
    const w = reviewWarnings(
      { documents: [doc], recipients: [dana], fields: [field('r1', 'SIGNATURE')] },
      banner,
      null,
    );
    expect(w).toHaveLength(1);
    expect(w[0]!.kind).toBe('limit');
    expect(w[0]!.text).toMatch(/You can send again at /);
    expect(w[0]!.text).not.toMatch(/tomorrow/i);
  });

  it('renders a backend refusal by its reason code', () => {
    const refusal = new ApiError({
      status: 403,
      code: 'INSUFFICIENT_PERMISSIONS',
      reason: 'personal_review_pending',
    });
    const w = reviewWarnings(
      { documents: [doc], recipients: [dana], fields: [field('r1', 'SIGNATURE')] },
      null,
      refusal,
    );
    expect(w).toEqual([
      { kind: 'refusal', text: 'Sending is paused while we review your account.' },
    ]);
    const unknown = new ApiError({
      status: 403,
      code: 'ESIGN_NOT_SUBSCRIBED',
      reason: 'ESIGN_NOT_SUBSCRIBED',
    });
    expect(
      reviewWarnings(
        { documents: [doc], recipients: [dana], fields: [field('r1', 'SIGNATURE')] },
        null,
        unknown,
      )[0]!.text,
    ).toBe('Your organization needs an Aramo Sign plan to send.');
  });

  it('does not repeat not_ready when a local warning already explains it', () => {
    const notReady = new ApiError({ status: 400, code: 'VALIDATION_ERROR', reason: 'not_ready' });
    const w = reviewWarnings({ documents: [doc], recipients: [dana], fields: [] }, null, notReady);
    expect(w.map((x) => x.kind)).toEqual(['no_signature_field']);
  });
});

describe('Before you send: recipient kinds (M-A5 §1.5, §2.1)', () => {
  const cc = {
    key: 'r3',
    serverId: null,
    name: 'Copy Person',
    email: 'cc@example.com',
    kind: 'RECEIVES_COPY' as const,
    copyDelivery: 'ON_COMPLETION' as const,
  };
  const walkIn = {
    key: 'r4',
    serverId: null,
    name: 'Walk In',
    email: '',
    kind: 'IN_PERSON_SIGNER' as const,
  };

  it('never asks a copy recipient for a signature field', () => {
    expect(
      reviewWarnings(
        { documents: [doc], recipients: [dana, cc], fields: [field('r1', 'SIGNATURE')] },
        null,
        null,
      ),
    ).toEqual([]);
  });

  it('flags a copy recipient that has fields', () => {
    const w = reviewWarnings(
      {
        documents: [doc],
        recipients: [dana, cc],
        fields: [field('r1', 'SIGNATURE'), field('r3', 'TEXT')],
      },
      null,
      null,
    );
    expect(w.map((x) => x.kind)).toEqual(['copy_with_fields']);
    expect(w[0]!.text).toMatch(/^Copy Person receives a copy and can’t have fields/);
  });

  it('needs at least one signing recipient: copies alone are not enough', () => {
    const w = reviewWarnings({ documents: [doc], recipients: [cc], fields: [] }, null, null);
    expect(w.map((x) => x.kind)).toEqual(['no_signer']);
  });

  it('flags a copy recipient without a timing', () => {
    const w = reviewWarnings(
      {
        documents: [doc],
        recipients: [dana, { ...cc, copyDelivery: null }],
        fields: [field('r1', 'SIGNATURE')],
      },
      null,
      null,
    );
    expect(w).toEqual([{ kind: 'copy_timing', text: 'Choose when Copy Person receives a copy.' }]);
  });

  it('asks an in-person signer for a signature field like any signer', () => {
    const w = reviewWarnings({ documents: [doc], recipients: [walkIn], fields: [] }, null, null);
    expect(w).toEqual([{ kind: 'no_signature_field', text: 'Walk In has no signature field.' }]);
  });
});
