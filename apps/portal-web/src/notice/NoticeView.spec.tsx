import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';

import { portalApi } from '../portal-api';

import { NoticeView } from './NoticeView';

// Portal P4a — the platform-notice page. portalApi stubbed at the method seam.
// Covers: the rendered notice paragraphs, and the honest error path.

describe('NoticeView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the platform notice text as paragraphs', async () => {
    vi.spyOn(portalApi, 'getNotice').mockResolvedValue({
      version: 'portal-notice-v1',
      text: 'First paragraph about your record.\n\nSecond paragraph about your rights.',
    });
    render(<NoticeView />);

    expect(
      await screen.findByText('First paragraph about your record.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Second paragraph about your rights.'),
    ).toBeInTheDocument();
  });

  it('surfaces the api error honestly', async () => {
    vi.spyOn(portalApi, 'getNotice').mockRejectedValue(
      new ApiError(500, 'boom', 'INTERNAL'),
    );
    render(<NoticeView />);

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
