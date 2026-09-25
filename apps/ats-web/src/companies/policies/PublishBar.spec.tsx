import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { PublishBar } from './PublishBar';

describe('PublishBar (§11 change summary)', () => {
  it('shows the change count and reveals the before→after summary in the confirm modal', async () => {
    const onPublish = vi.fn();
    render(
      <PublishBar
        changes={['Bill rate: Inherit → Required (Not allowed)', 'Voice engagement: Not required → Required']}
        publishing={false}
        title="Client Submittal Policy"
        nextVersion="3"
        onCancel={vi.fn()}
        onPublish={onPublish}
      />,
    );
    expect(screen.getByText('2 changes to publish')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Publish changes' }));
    // the confirmation modal carries the exact deltas + the next version
    expect(screen.getByText('Publish Client Submittal Policy?')).toBeInTheDocument();
    expect(screen.getByText('Technology Ventures · becomes version 3')).toBeInTheDocument();
    expect(screen.getByText('Bill rate: Inherit → Required (Not allowed)')).toBeInTheDocument();
    expect(screen.getByText('Voice engagement: Not required → Required')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(onPublish).toHaveBeenCalledTimes(1));
  });

  it('disables publish when there are no changes', () => {
    render(
      <PublishBar changes={[]} publishing={false} title="Engagement Policy" nextVersion="1" onCancel={vi.fn()} onPublish={vi.fn()} />,
    );
    expect(screen.getByText('No changes yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish changes' })).toBeDisabled();
  });

  it('disables both actions while publishing', () => {
    render(
      <PublishBar
        changes={['x: a → b']}
        publishing={true}
        title="Pre-Start Policy"
        nextVersion="2"
        onCancel={vi.fn()}
        onPublish={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Publish changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});
