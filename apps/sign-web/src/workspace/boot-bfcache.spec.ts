import { describe, expect, it, vi } from 'vitest';

import { reloadWhenRestoredFromCache } from './boot';

// UAT SIN-10 — a signed-in page restored by the Back button (back/forward cache) reloads, so a
// signed-out browser never shows the frozen account data.
function fakeWindow() {
  const target = new EventTarget();
  const reload = vi.fn();
  return {
    win: { addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), location: { reload } },
    target,
    reload,
  };
}
const pageshow = (persisted: boolean) => Object.assign(new Event('pageshow'), { persisted });

describe('back/forward cache', () => {
  it('reloads a page restored from the cache', () => {
    const { win, target, reload } = fakeWindow();
    reloadWhenRestoredFromCache(win as never);
    target.dispatchEvent(pageshow(true));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a normal load does not reload, and cleanup removes the listener', () => {
    const { win, target, reload } = fakeWindow();
    const stop = reloadWhenRestoredFromCache(win as never);
    target.dispatchEvent(pageshow(false));
    stop();
    target.dispatchEvent(pageshow(true));
    expect(reload).not.toHaveBeenCalled();
  });
});
