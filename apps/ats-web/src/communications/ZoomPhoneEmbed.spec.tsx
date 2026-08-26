import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ZoomPhoneEmbed, type ZoomEmbedLoader } from './ZoomPhoneEmbed';

// COMM-B4 Boundary B — the Zoom browser boundary. B4 ships an INJECTABLE loader;
// the default is an inert stub (real Smart Embed load = COMM-B8). These specs
// prove (1) the placeholder renders with no real Zoom dependency, and (2) an
// injected loader is attached to the rendered container — the seam B8 fills.

describe('ZoomPhoneEmbed', () => {
  it('renders the placeholder region with the default inert stub loader', () => {
    render(<ZoomPhoneEmbed />);
    const region = screen.getByTestId('zoom-phone-embed');
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute('aria-label', 'Zoom Phone');
    expect(
      screen.getByText(/dialer opens in your Zoom app/i),
    ).toBeInTheDocument();
  });

  it('attaches an injected loader to the rendered container element', async () => {
    const attach = vi.fn();
    const loader: ZoomEmbedLoader = { attach };
    render(<ZoomPhoneEmbed loader={loader} />);

    await waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
    // The boundary hands the loader the actual DOM container it renders — the
    // exact seam COMM-B8's real Smart Embed load will target.
    const container = screen.getByTestId('zoom-phone-embed');
    expect(attach).toHaveBeenCalledWith(container);
  });
});
