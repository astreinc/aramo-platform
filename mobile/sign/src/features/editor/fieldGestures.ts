// Drag and resize gestures for a placed field (handoff §4.6): a press becomes a drag
// after 4px (geometry.ts isDrag), a whole drag is one undo step (beginGesture), and the
// box stays inside the page (the reducer clamps). A plain object, outside React, so the
// gesture callbacks can read the latest props without touching refs during render.
import { PanResponder, type PanResponderInstance } from 'react-native';

import type { EditorAction, EditorField } from './editorReducer';
import { isDrag, type PageSize } from './geometry';

export interface FieldGestureProps {
  readonly field: EditorField;
  /** dp per point. */
  readonly scale: number;
  readonly page: PageSize;
}

export interface FieldGestures {
  readonly move: PanResponderInstance;
  readonly resize: PanResponderInstance;
  setLive(p: FieldGestureProps): void;
}

export function createFieldGestures(
  dispatch: (a: EditorAction) => void,
  onGesture?: (active: boolean) => void,
): FieldGestures {
  let live: FieldGestureProps | null = null;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;
  let dragging = false;
  let resizing = false;

  const move = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => !dragging,
    onPanResponderGrant: () => {
      startX = live?.field.x ?? 0;
      startY = live?.field.y ?? 0;
      dragging = false;
    },
    onPanResponderMove: (_e, d) => {
      if (!live) return;
      if (!dragging) {
        if (!isDrag(d.dx, d.dy)) return;
        dragging = true;
        onGesture?.(true);
        dispatch({ type: 'select', key: live.field.key });
        dispatch({ type: 'beginGesture' });
      }
      dispatch({
        type: 'moveTo',
        key: live.field.key,
        to: { x: startX + d.dx / live.scale, y: startY + d.dy / live.scale },
        pageSize: live.page,
      });
    },
    onPanResponderRelease: () => {
      if (dragging) onGesture?.(false);
      else if (live) dispatch({ type: 'select', key: live.field.key });
      dragging = false;
    },
    onPanResponderTerminate: () => {
      if (dragging) onGesture?.(false);
      dragging = false;
    },
  });

  const resize = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      startW = live?.field.width ?? 0;
      startH = live?.field.height ?? 0;
      resizing = false;
      onGesture?.(true);
    },
    onPanResponderMove: (_e, d) => {
      if (!live) return;
      if (!resizing) {
        if (!isDrag(d.dx, d.dy)) return;
        resizing = true;
        dispatch({ type: 'beginGesture' });
      }
      dispatch({
        type: 'resizeTo',
        key: live.field.key,
        size: { width: startW + d.dx / live.scale, height: startH + d.dy / live.scale },
        pageSize: live.page,
      });
    },
    onPanResponderRelease: () => onGesture?.(false),
    onPanResponderTerminate: () => onGesture?.(false),
  });

  return {
    move,
    resize,
    setLive(p) {
      live = p;
    },
  };
}
