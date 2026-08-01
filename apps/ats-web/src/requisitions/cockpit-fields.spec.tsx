import { fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider } from '@aramo/fe-foundation';
import { describe, expect, it, vi } from 'vitest';

import { CockpitFieldRow } from './cockpit-fields';
import { COCKPIT_FIELDS } from './field-affordance';

// D2 (#14) — start_date arrives from the API as a full ISO string; the cockpit
// used to hand it to the type="date" editor verbatim, showing raw ISO in the
// read display and leaving the date input blank/broken. It now passes the
// shared formatDate() output (YYYY-MM-DD).
const START_DATE_FIELD = COCKPIT_FIELDS.find((f) => f.key === 'start_date')!;
const RAW_ISO = '2026-08-01T00:00:00.000Z';

describe('CockpitFieldRow — D2 #14 start_date raw-ISO fix', () => {
  it('read-only: displays the calendar date, not the raw ISO', () => {
    render(
      <ToastProvider>
        <CockpitFieldRow
          field={START_DATE_FIELD}
          raw={RAW_ISO}
          scopes={[]} /* cannot edit OPEN → read-only display */
          onSave={vi.fn()}
        />
      </ToastProvider>,
    );
    expect(screen.getByText('2026-08-01')).toBeTruthy();
    expect(screen.queryByText(RAW_ISO)).toBeNull();
  });

  it('editable: the type="date" input is seeded with a valid YYYY-MM-DD value', () => {
    render(
      <ToastProvider>
        <CockpitFieldRow
          field={START_DATE_FIELD}
          raw={RAW_ISO}
          scopes={['requisition:edit']} /* OPEN editable */
          onSave={vi.fn()}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Start date' }));
    const input = screen.getByDisplayValue('2026-08-01') as HTMLInputElement;
    expect(input.type).toBe('date');
  });
});
