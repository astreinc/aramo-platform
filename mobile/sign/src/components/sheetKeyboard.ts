// M-A13 #5 — keep a sheet's focused input above the keyboard.
//
// iOS: the page sheet's ScrollView adjusts its own insets (UIKit keyboard notifications,
// `automaticallyAdjustKeyboardInsets`) and scrolls the focused input into view.
// Android: the Modal dialog is edge-to-edge (gradle `edgeToEdgeEnabled`), so
// `adjustResize` does not shrink it. The bottom sheet is lifted by the keyboard height
// instead. If the dialog WAS resized (its root got shorter), the lift is reduced by that
// amount so it never counts twice. If no keyboard event reaches JS while an input inside
// the sheet has focus, the sheet is anchored to the top of the screen so the input still
// stays visible.
import { useEffect, useState } from 'react';
import { Keyboard, Platform, type KeyboardEvent } from 'react-native';

/** How long a focused input waits for a keyboard event before the top-anchor fallback. */
export const KEYBOARD_EVENT_GRACE_MS = 350;

export type SheetPlacement =
  | { readonly kind: 'bottom'; readonly lift: number }
  | { readonly kind: 'top' };

export function androidSheetPlacement(input: {
  /** Keyboard height from the last keyboard event (0 = hidden / no event). */
  readonly keyboard: number;
  /** The tallest the sheet's root has been laid out (the un-resized dialog). */
  readonly fullHeight: number;
  /** The root's current height. */
  readonly rootHeight: number;
  /** An input inside the sheet has had focus for the grace period with no keyboard event. */
  readonly focusedWithoutEvent: boolean;
}): SheetPlacement {
  if (input.keyboard > 0) {
    const resizedBy = Math.max(0, input.fullHeight - input.rootHeight);
    return { kind: 'bottom', lift: Math.max(0, Math.round(input.keyboard - resizedBy)) };
  }
  if (input.focusedWithoutEvent) return { kind: 'top' };
  return { kind: 'bottom', lift: 0 };
}

/** The keyboard height as JS sees it (0 while hidden, or while not `active`). */
export function useKeyboardHeight(active: boolean): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!active) return;
    const ios = Platform.OS === 'ios';
    const onShow = (e: KeyboardEvent) => setHeight(e.endCoordinates?.height ?? 0);
    const onHide = () => setHeight(0);
    const subs = [
      Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', onShow),
      Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', onHide),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [active]);
  return active ? height : 0;
}

/**
 * Tracks whether an input inside the sheet has focus (Android focus/blur events bubble
 * to the enclosing View) and whether the grace period passed without a keyboard event.
 */
export function useFocusFallback(keyboard: number): {
  readonly focusedWithoutEvent: boolean;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
} {
  const [focus, setFocus] = useState({ id: 0, on: false });
  const [expiredId, setExpiredId] = useState(-1);
  // Once a keyboard event has arrived, events work here: no fallback (a keyboard closed
  // with Back leaves the input focused, and the sheet must then return to the bottom).
  const [seenEvent, setSeenEvent] = useState(false);
  if (keyboard > 0 && !seenEvent) setSeenEvent(true);
  const waiting = focus.on && keyboard === 0 && !seenEvent;
  useEffect(() => {
    if (!waiting) return;
    const id = focus.id;
    const timer = setTimeout(() => setExpiredId(id), KEYBOARD_EVENT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [waiting, focus.id]);
  return {
    focusedWithoutEvent: waiting && expiredId === focus.id,
    onFocus: () => setFocus((f) => ({ id: f.id + 1, on: true })),
    onBlur: () => setFocus((f) => ({ id: f.id, on: false })),
  };
}
