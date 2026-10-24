import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Pill, tenantStatusPill } from './Pill';
import { permissionLabel } from './permissions';

describe('Pill (handoff §3.7)', () => {
  it.each(['ok', 'info', 'warn', 'danger', 'neutral'] as const)('maps %s onto the StatusPill tone', (tone) => {
    const { container } = render(<Pill tone={tone}>Label</Pill>);
    expect(container.querySelector(`.pw-pill--${tone} .rc-pill--${tone}`)).not.toBeNull();
    expect(container.querySelector('.rc-pill__dot')).not.toBeNull();
  });

  it('renders muted with the U-0 StatusPill muted tone', () => {
    const { container } = render(<Pill tone="muted">Closed</Pill>);
    expect(container.querySelector('.pw-pill--muted .rc-pill--muted')).not.toBeNull();
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });

  it('drops the dot for the inline and Change-box sizes', () => {
    const { container } = render(
      <>
        <Pill tone="ok" size="sm">
          a
        </Pill>
        <Pill tone="ok" size="lg" strong>
          b
        </Pill>
      </>,
    );
    expect(container.querySelector('.rc-pill__dot')).toBeNull();
    expect(container.querySelector('.pw-pill--strong')).not.toBeNull();
  });

  it('maps tenant statuses to labels and tones', () => {
    expect(tenantStatusPill('SUSPENDED')).toEqual({ label: 'Suspended', tone: 'warn' });
    expect(tenantStatusPill('CLOSED')).toEqual({ label: 'Closed', tone: 'muted' });
    expect(tenantStatusPill('WEIRD')).toEqual({ label: 'WEIRD', tone: 'neutral' });
  });

  it('labels permissions in plain words', () => {
    expect(permissionLabel('platform:tenant:lifecycle:manage')).toBe('Manage tenant lifecycle');
    expect(permissionLabel('platform:unknown')).toBe('platform:unknown');
  });
});
