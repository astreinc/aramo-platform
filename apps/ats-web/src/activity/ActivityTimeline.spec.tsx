import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActivityTimeline } from './ActivityTimeline';

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

describe('ActivityTimeline — D2 #7 raw-ISO fix', () => {
  it('shows the formatted calendar date, not the raw ISO timestamp', async () => {
    render(<ActivityTimeline requisitionId="req-1" pipelineIds={[]} />);

    const time = await screen.findByText('2026-08-01');
    expect(time.tagName).toBe('TIME');
    // The visible text is date-only; the raw ISO no longer leaks to the user.
    expect(screen.queryByText(ISO)).toBeNull();
    // …but the machine-readable attribute preserves the full instant.
    expect(time).toHaveAttribute('dateTime', ISO);
  });
});
