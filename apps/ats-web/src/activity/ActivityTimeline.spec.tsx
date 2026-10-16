import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActivityTimeline, describeActivity } from './ActivityTimeline';
import type { ActivityView } from './types';

// D2 (#7) — the timeline used to render `a.created_at` verbatim (raw ISO).
// It now renders the shared formatDate() output; the machine-readable
// <time dateTime> attribute keeps the full ISO.
// vi.mock is hoisted above imports, so the fixture it references must come
// from vi.hoisted (evaluated first) rather than a plain module-scope const.
const { ISO, activity } = vi.hoisted(() => {
  const iso = '2026-08-01T14:22:31.000Z';
  return {
    ISO: iso,
    activity: {
      id: 'act-1',
      tenant_id: 't-1',
      site_id: null,
      type: 'note',
      subject_type: 'requisition',
      subject_id: 'req-1',
      notes: 'a logged note',
      created_by_id: null,
      created_at: iso,
    },
  };
});

vi.mock('./activity-api', () => ({
  listActivities: vi.fn().mockResolvedValue({ items: [activity] }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('ActivityTimeline — compact prototype rows', () => {
  it('shows a relative time with the full instant kept on the <time> element', async () => {
    render(<ActivityTimeline requisitionId="req-1" pipelineIds={[]} />);

    const time = await screen.findByText(/ago$|^today$|^yesterday$/);
    expect(time.tagName).toBe('TIME');
    // The raw ISO never leaks into the visible text…
    expect(screen.queryByText(ISO)).toBeNull();
    // …but the machine-readable attribute keeps the instant and the hover shows the date.
    expect(time).toHaveAttribute('dateTime', ISO);
    expect(time).toHaveAttribute('title', '2026-08-01');
  });

  it('renders ONE card of rows (no per-entry cards, no list bullets)', async () => {
    const { container } = render(<ActivityTimeline requisitionId="req-1" pipelineIds={[]} />);
    await screen.findByText('REQUISITION');
    expect(container.querySelectorAll('.rc-card')).toHaveLength(1);
    expect(container.querySelector('ul')).toBeNull();
  });
});

describe('describeActivity — reads like the prototype, from stored truth only', () => {
  const base = {
    id: 'a-1',
    tenant_id: 't-1',
    site_id: null,
    created_at: ISO,
    redacted_at: null,
    category: null,
  } as unknown as ActivityView;
  const talents = { 'pl-1': 'Vinothini Elanchezhian' };
  const users = { 'u-1': 'Deepika' };

  it('a stage change leads with the new stage, names the Talent and who moved it', () => {
    const row = describeActivity(
      { ...base, type: 'pipeline_status_change', subject_type: 'pipeline', subject_id: 'pl-1', created_by_id: 'u-1', notes: 'pipeline qualifying -> qualified' },
      talents,
      users,
    );
    expect(row).toEqual({
      domain: 'PIPELINE',
      what: 'Qualified',
      detail: 'Vinothini Elanchezhian · moved by Deepika',
      tone: 'brand',
    });
  });

  it('the VOID correction reads as a removal with no internal reason code', () => {
    const row = describeActivity(
      { ...base, type: 'pipeline_status_change', subject_type: 'pipeline', subject_id: 'pl-1', created_by_id: 'u-1', notes: 'pipeline no_contact -> voided (accidental-add correction: ADDED_BY_MISTAKE)' },
      talents,
      users,
    );
    expect(row.what).toBe('Removed (added by mistake)');
    expect(row.detail).toBe('Vinothini Elanchezhian · removed by Deepika');
    expect(row.tone).toBe('mute');
  });

  it('keeps the transition note and drops evidence ids', () => {
    const row = describeActivity(
      { ...base, type: 'pipeline_status_change', subject_type: 'pipeline', subject_id: 'pl-1', created_by_id: 'u-1', notes: 'pipeline contacted -> talent_responded: replied [evidence communication:9f1c]' },
      talents,
      users,
    );
    expect(row.detail).toBe('Vinothini Elanchezhian · moved by Deepika · replied');
  });

  it('omits names it cannot resolve rather than showing an id', () => {
    const row = describeActivity(
      { ...base, type: 'pipeline_status_change', subject_type: 'pipeline', subject_id: 'pl-x', created_by_id: 'u-x', notes: 'pipeline no_contact -> contacted' },
      talents,
      users,
    );
    expect(row.what).toBe('Contacted');
    expect(row.detail).toBe('');
  });

  it('a requisition note shows its category and body', () => {
    const row = describeActivity(
      { ...base, type: 'note', subject_type: 'requisition', subject_id: 'req-1', created_by_id: 'u-1', notes: 'Client wants hybrid', category: 'CLIENT_INTERACTION' } as ActivityView,
      talents,
      users,
    );
    expect(row).toEqual({ domain: 'REQUISITION', what: 'Client interaction', detail: 'by Deepika · Client wants hybrid', tone: 'mute' });
  });
});
