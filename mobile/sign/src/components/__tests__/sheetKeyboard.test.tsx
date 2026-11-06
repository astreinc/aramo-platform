// M-A13 #5 — the shared Sheet keeps a focused input above the keyboard.
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { DeviceEventEmitter, Platform, StyleSheet, Text, TextInput } from 'react-native';

import { Sheet } from '../Sheet';
import { androidSheetPlacement, KEYBOARD_EVENT_GRACE_MS } from '../sheetKeyboard';

describe('androidSheetPlacement', () => {
  it('lifts the sheet by the keyboard height when the dialog is not resized', () => {
    expect(
      androidSheetPlacement({
        keyboard: 300,
        fullHeight: 800,
        rootHeight: 800,
        focusedWithoutEvent: false,
      }),
    ).toEqual({ kind: 'bottom', lift: 300 });
  });

  it('never counts the keyboard twice when the dialog was resized', () => {
    expect(
      androidSheetPlacement({
        keyboard: 300,
        fullHeight: 800,
        rootHeight: 500,
        focusedWithoutEvent: false,
      }),
    ).toEqual({ kind: 'bottom', lift: 0 });
  });

  it('anchors to the top when an input is focused but no keyboard event arrived', () => {
    expect(
      androidSheetPlacement({ keyboard: 0, fullHeight: 800, rootHeight: 800, focusedWithoutEvent: true }),
    ).toEqual({ kind: 'top' });
  });

  it('sits at the bottom with no keyboard', () => {
    expect(
      androidSheetPlacement({ keyboard: 0, fullHeight: 800, rootHeight: 800, focusedWithoutEvent: false }),
    ).toEqual({ kind: 'bottom', lift: 0 });
  });
});

function renderSheet() {
  return render(
    <Sheet visible onClose={() => undefined} title="Rename">
      <Text>Name</Text>
      <TextInput testID="input" />
    </Sheet>,
  );
}

function sheetStyle() {
  return StyleSheet.flatten(screen.getByTestId('sheet-android').props.style);
}

describe('Sheet on Android', () => {
  let restore: () => void;
  beforeEach(() => {
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    restore = () => Object.defineProperty(Platform, 'OS', { configurable: true, get: () => original });
  });
  afterEach(() => {
    restore();
    jest.useRealTimers();
  });

  it('rises above the keyboard and comes back down when it hides', () => {
    renderSheet();
    expect(sheetStyle().bottom).toBe(0);
    act(() => {
      DeviceEventEmitter.emit('keyboardDidShow', { endCoordinates: { height: 320, screenY: 480 } });
    });
    expect(sheetStyle().bottom).toBe(320);
    act(() => {
      DeviceEventEmitter.emit('keyboardDidHide', { endCoordinates: { height: 0, screenY: 800 } });
    });
    expect(sheetStyle().bottom).toBe(0);
  });

  it('moves to the top while an input has focus and no keyboard event arrives', () => {
    jest.useFakeTimers();
    renderSheet();
    fireEvent(screen.getByTestId('sheet-android'), 'focus');
    expect(sheetStyle().top).toBeUndefined();
    act(() => {
      jest.advanceTimersByTime(KEYBOARD_EVENT_GRACE_MS + 10);
    });
    expect(sheetStyle().top).toBeGreaterThanOrEqual(0);
    fireEvent(screen.getByTestId('sheet-android'), 'blur');
    expect(sheetStyle().top).toBeUndefined();
  });
});
