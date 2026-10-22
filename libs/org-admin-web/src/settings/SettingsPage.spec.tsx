import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsPage } from './SettingsPage';

// ORG-UX-1 (§8.7, P4, G6) — Regional defaults render disabled, "Coming soon", no Save.

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 500 }));
});

describe('SettingsPage', () => {
  it('renders the five regional-default selects disabled, labelled Coming soon', () => {
    render(<SettingsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText(/New people and every Aramo app start with these/)).toBeInTheDocument();
    for (const label of ['Time zone', 'Date format', 'Language', 'Currency', 'Week starts on']) {
      const select = screen.getByLabelText(label);
      expect(select).toBeDisabled();
      expect(select).toHaveDisplayValue('Coming soon');
    }
    expect(screen.getAllByText(/Coming soon/).length).toBeGreaterThan(1);
  });

  it('has no active Save', () => {
    render(<SettingsPage />);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
});
