// M-A13 #4 — the online state is re-read on foreground / pull-to-refresh, and any
// server answer marks the app online (the "Offline" banner must not stick).
import { onlineManager, QueryClient, QueryObserver } from '@tanstack/react-query';
import type * as Network from 'expo-network';

import {
  noteServerResponse,
  recheckOnline,
  wireOnlineManager,
} from '../queryClient';

jest.mock('expo-network', () => ({
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
  getNetworkStateAsync: jest.fn(async () => ({ isConnected: true, isInternetReachable: true })),
}));

const ONLINE = { isConnected: true, isInternetReachable: true } as Network.NetworkState;
const OFFLINE = { isConnected: false, isInternetReachable: false } as Network.NetworkState;

function client(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.mount();
  return qc;
}

afterEach(() => onlineManager.setOnline(true));

describe('recheckOnline', () => {
  it('clears a stuck offline state and refetches the active queries', async () => {
    const qc = client();
    const fn = jest.fn(async () => 'fresh');
    // An observer makes the query "active".
    const observer = new QueryObserver(qc, { queryKey: ['k'], queryFn: fn });
    const stop = observer.subscribe(() => undefined);
    await qc.refetchQueries({ queryKey: ['k'] });
    fn.mockClear();

    onlineManager.setOnline(false);
    expect(onlineManager.isOnline()).toBe(false);
    const online = await recheckOnline(qc, async () => ONLINE);
    expect(online).toBe(true);
    expect(onlineManager.isOnline()).toBe(true);
    expect(fn).toHaveBeenCalled();
    expect(qc.getQueryData(['k'])).toBe('fresh');
    stop();
    qc.unmount();
  });

  it('resumes a mutation that was paused while offline', async () => {
    const qc = client();
    onlineManager.setOnline(false);
    const fn = jest.fn(async () => 'done');
    const pending = qc
      .getMutationCache()
      .build(qc, { mutationFn: fn, networkMode: 'online' })
      .execute(undefined);
    await Promise.resolve();
    expect(fn).not.toHaveBeenCalled();
    // A listener event that never arrives: only the re-check brings it back.
    await recheckOnline(qc, async () => ONLINE);
    await expect(pending).resolves.toBe('done');
    qc.unmount();
  });

  it('stays offline (and does not refetch) when the network really is down', async () => {
    const qc = client();
    const spy = jest.spyOn(qc, 'refetchQueries');
    expect(await recheckOnline(qc, async () => OFFLINE)).toBe(false);
    expect(onlineManager.isOnline()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    qc.unmount();
  });

  it('keeps the current state if the network state cannot be read', async () => {
    const qc = client();
    onlineManager.setOnline(false);
    expect(
      await recheckOnline(qc, async () => {
        throw new Error('native');
      }),
    ).toBe(false);
    qc.unmount();
  });
});

describe('noteServerResponse', () => {
  it('marks the app online', () => {
    onlineManager.setOnline(false);
    noteServerResponse();
    expect(onlineManager.isOnline()).toBe(true);
  });
});

describe('wireOnlineManager', () => {
  it('re-checks when the app returns to the foreground, not on background', async () => {
    const qc = client();
    let listener: ((s: string) => void) | undefined;
    const remove = jest.fn();
    const appState = {
      addEventListener: jest.fn((_t: 'change', l: (s: string) => void) => {
        listener = l;
        return { remove };
      }),
    };
    const unwire = wireOnlineManager(qc, appState as never);
    onlineManager.setOnline(false);
    listener?.('background');
    await new Promise((r) => setTimeout(r, 0));
    expect(onlineManager.isOnline()).toBe(false);
    listener?.('active');
    await new Promise((r) => setTimeout(r, 0));
    expect(onlineManager.isOnline()).toBe(true);
    unwire();
    expect(remove).toHaveBeenCalled();
    qc.unmount();
  });
});
