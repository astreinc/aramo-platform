import { ApiError } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DEVICES_COPY, DevicesSection, phoneLabel, type PhoneSession } from './DevicesSection';

// Amendment M-A18 (LOCKED) — Settings → Devices.

const ANDROID: PhoneSession = {
  device_session_id: '01900000-0000-7000-8000-00000000c001',
  platform: 'android',
  app_version: '1.0.1',
  created_at: '2026-11-10T10:00:00Z',
  last_seen_at: '2026-11-18T09:00:00Z',
};
const IPHONE: PhoneSession = {
  device_session_id: '01900000-0000-7000-8000-00000000c002',
  platform: 'ios',
  app_version: '1.0.1',
  created_at: '2026-11-01T10:00:00Z',
  last_seen_at: '2026-11-12T09:00:00Z',
};

function api(items: PhoneSession[], signOut: (id: string) => Promise<void> = async () => undefined) {
  return { list: vi.fn(async () => items), signOut: vi.fn(signOut) };
}

describe('Settings → Devices (M-A18)', () => {
  it('lists the phones, most recently used first, with a readable label', async () => {
    render(<DevicesSection api={api([IPHONE, ANDROID])} />);
    const rows = await screen.findAllByTestId('device-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Android phone · Aramo Sign 1.0.1');
    expect(rows[1]).toHaveTextContent('iPhone · Aramo Sign 1.0.1');
    expect(phoneLabel({ platform: 'other', app_version: null })).toBe('Phone');
  });

  it('shows the empty state', async () => {
    render(<DevicesSection api={api([])} />);
    expect(await screen.findByTestId('devices-empty')).toHaveTextContent(DEVICES_COPY.empty);
  });

  it('Sign out asks first, then signs the phone out and removes the row', async () => {
    const a = api([ANDROID]);
    render(<DevicesSection api={a} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out Android phone · Aramo Sign 1.0.1' }));
    expect(screen.getByText(DEVICES_COPY.confirm)).toBeInTheDocument();
    expect(a.signOut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('device-signout-confirm'));
    await waitFor(() => expect(a.signOut).toHaveBeenCalledWith(ANDROID.device_session_id));
    await waitFor(() => expect(screen.queryAllByTestId('device-row')).toHaveLength(0));
    expect(screen.getByTestId('devices-notice')).toHaveTextContent('within 15 minutes');
  });

  it('Cancel keeps the phone signed in', async () => {
    const a = api([ANDROID]);
    render(<DevicesSection api={a} />);
    fireEvent.click(await screen.findByRole('button', { name: /Sign out Android/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(a.signOut).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('device-row')).toHaveLength(1);
  });

  it('a phone already signed out elsewhere (404) just leaves the list', async () => {
    const a = api([ANDROID], async () => {
      throw new ApiError(404, 'Device session not found', 'NOT_FOUND');
    });
    render(<DevicesSection api={a} />);
    fireEvent.click(await screen.findByRole('button', { name: /Sign out Android/ }));
    fireEvent.click(screen.getByTestId('device-signout-confirm'));
    await waitFor(() => expect(screen.queryAllByTestId('device-row')).toHaveLength(0));
  });

  it('another failure keeps the row and says so', async () => {
    const a = api([ANDROID], async () => {
      throw new ApiError(500, 'boom', 'INTERNAL');
    });
    render(<DevicesSection api={a} />);
    fireEvent.click(await screen.findByRole('button', { name: /Sign out Android/ }));
    fireEvent.click(screen.getByTestId('device-signout-confirm'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getAllByTestId('device-row')).toHaveLength(1);
  });
});
