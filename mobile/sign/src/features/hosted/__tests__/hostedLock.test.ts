// While hosted mode is locked, a tapped push opens nothing over it (M-A5 §3.3).
import { navigationRef } from '../../../navigation/navigationRef';
import { openTarget } from '../../notifications/usePushLifecycle';
import { isHostedLocked, setHostedLocked } from '../hostedLock';

jest.mock('expo-notifications', () => ({}));

afterEach(() => setHostedLocked(false));

it('push targets do not navigate while hosted mode is locked', () => {
  const ready = jest.spyOn(navigationRef, 'isReady').mockReturnValue(true);
  const navigate = jest.spyOn(navigationRef, 'navigate').mockImplementation(() => undefined);
  setHostedLocked(true);
  expect(isHostedLocked()).toBe(true);
  openTarget({ name: 'EnvelopeDetail', params: { envelopeId: 'e1' } });
  expect(navigate).not.toHaveBeenCalled();
  setHostedLocked(false);
  openTarget({ name: 'EnvelopeDetail', params: { envelopeId: 'e1' } });
  expect(navigate).toHaveBeenCalledWith('EnvelopeDetail', { envelopeId: 'e1' });
  ready.mockRestore();
  navigate.mockRestore();
});
