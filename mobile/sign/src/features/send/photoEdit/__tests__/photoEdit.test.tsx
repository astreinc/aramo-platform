// M-A13 #9 — the per-photo crop / straighten / rotate step.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useEffect } from 'react';

import {
  cropBounds,
  cropPixels,
  initialEdit,
  isIdentity,
  moveCorner,
  normalizeQuarter,
  quarterSize,
  stageLayout,
  totalRotation,
  turnedBox,
} from '../photoCrop';
import type { PhotoEditPort } from '../photoEditNative';
import { usePhotoEditor, type PhotoEditFn } from '../PhotoEditor';

jest.mock('expo-image-manipulator', () => ({ ImageManipulator: {}, SaveFormat: { JPEG: 'jpeg' } }));
jest.mock('expo-file-system', () => ({ File: class {} }));

describe('photo crop geometry', () => {
  it('quarter turns swap the sides and wrap', () => {
    expect(normalizeQuarter(-90)).toBe(270);
    expect(normalizeQuarter(450)).toBe(90);
    expect(quarterSize({ width: 4, height: 3 }, 90)).toEqual({ width: 3, height: 4 });
    expect(totalRotation({ quarter: 270, straighten: -5 })).toBe(265);
  });

  it('no straighten: the bounds are the whole picture', () => {
    expect(cropBounds({ width: 400, height: 300 }, 90, 0)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('straightening keeps the crop inside the turned picture (no empty corners)', () => {
    const src = { width: 400, height: 300 };
    const deg = 10;
    const box = turnedBox(src, 0, deg);
    const b = cropBounds(src, 0, deg);
    // Same shape as the picture.
    expect((b.w * box.width) / (b.h * box.height)).toBeCloseTo(400 / 300, 6);
    // Each corner of the bounds, turned back, lies inside the original picture.
    const a = (-deg * Math.PI) / 180;
    for (const [fx, fy] of [
      [b.x, b.y],
      [b.x + b.w, b.y],
      [b.x, b.y + b.h],
      [b.x + b.w, b.y + b.h],
    ] as const) {
      const px = fx * box.width - box.width / 2;
      const py = fy * box.height - box.height / 2;
      const ux = px * Math.cos(a) - py * Math.sin(a);
      const uy = px * Math.sin(a) + py * Math.cos(a);
      expect(Math.abs(ux)).toBeLessThanOrEqual(200 + 1e-6);
      expect(Math.abs(uy)).toBeLessThanOrEqual(150 + 1e-6);
    }
  });

  it('corners move inside the bounds and never below the minimum size', () => {
    const bounds = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    const min = { w: 0.1, h: 0.1 };
    expect(moveCorner(bounds, 'tl', -0.5, -0.5, bounds, min)).toEqual(bounds);
    const r = moveCorner(bounds, 'br', -0.2, -0.3, bounds, min);
    expect(r.x).toBe(0.1);
    expect(r.w).toBeCloseTo(0.6);
    expect(r.h).toBeCloseTo(0.5);
    const tiny = moveCorner(bounds, 'tr', -5, 5, bounds, min);
    expect(tiny.w).toBeCloseTo(0.1);
    expect(tiny.h).toBeCloseTo(0.1);
  });

  it('crop fractions become whole pixels inside the image', () => {
    expect(cropPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 }, { width: 401, height: 300 })).toEqual({
      originX: 100,
      originY: 150,
      width: 201,
      height: 150,
    });
    const edge = cropPixels({ x: 0.999, y: 0, w: 1, h: 1 }, { width: 100, height: 100 });
    expect(edge.originX + edge.width).toBeLessThanOrEqual(100);
  });

  it('an untouched edit is the identity; a quarter turn is not', () => {
    expect(isIdentity(initialEdit())).toBe(true);
    expect(isIdentity({ ...initialEdit(), quarter: 90 })).toBe(false);
    expect(isIdentity({ ...initialEdit(), crop: { x: 0, y: 0, w: 0.5, h: 1 } })).toBe(false);
  });

  it('the turned picture fits the stage, centred', () => {
    const l = stageLayout({ width: 400, height: 300 }, 90, 0, { width: 300, height: 300 });
    expect(l.box.height).toBeCloseTo(300);
    expect(l.box.width).toBeCloseTo(225);
    expect(l.left).toBeCloseTo(37.5);
  });
});

function fakePort() {
  const applied: { uri: string; quarter: number; straighten: number }[] = [];
  const discarded: string[] = [];
  const port: PhotoEditPort = {
    prepare: async (uri) => ({ uri: `${uri}#up`, width: 400, height: 300 }),
    apply: async (photo, edit) => {
      applied.push({ uri: photo.uri, quarter: edit.quarter, straighten: edit.straighten });
      return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    },
    discard: (uri) => {
      discarded.push(uri);
    },
  };
  return { port, applied, discarded };
}

function Harness({ port, onEdit }: { port: PhotoEditPort; onEdit: (fn: PhotoEditFn) => void }) {
  const { edit, element } = usePhotoEditor(port);
  useEffect(() => {
    onEdit(edit);
  }, [edit, onEdit]);
  return element;
}

async function start(port: PhotoEditPort, uris: string[]) {
  let fn: PhotoEditFn | null = null;
  render(
    <Harness
      port={port}
      onEdit={(f) => {
        fn = f;
      }}
    />,
  );
  let pending!: ReturnType<PhotoEditFn>;
  await act(async () => {
    pending = fn!(uris.map((uri) => ({ uri })));
  });
  // Wrapped: returning the promise itself would make `await start()` wait for it.
  return { pending };
}

describe('PhotoEditor', () => {
  it('one step per photo: a turned photo is re-rendered, an untouched one keeps its bytes', async () => {
    const f = fakePort();
    const { pending } = await start(f.port, ['file:///a.jpg', 'file:///b.jpg']);
    expect(await screen.findByText('Photo 1 of 2')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('photo-edit-next').props.accessibilityState?.disabled).not.toBe(true));
    fireEvent.press(screen.getByTestId('photo-rotate-right'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('photo-edit-next'));
    });
    expect(await screen.findByText('Photo 2 of 2')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('photo-edit-next').props.accessibilityState?.disabled).not.toBe(true));
    await act(async () => {
      fireEvent.press(screen.getByTestId('photo-edit-next'));
    });
    const r = await pending;
    expect(r).toHaveLength(2);
    expect(r?.[0]).toBeInstanceOf(Uint8Array);
    expect(r?.[1]).toBeNull();
    expect(f.applied).toEqual([{ uri: 'file:///a.jpg#up', quarter: 90, straighten: 0 }]);
    // Upright working copies are deleted.
    expect(f.discarded.sort()).toEqual(['file:///a.jpg#up', 'file:///b.jpg#up']);
    expect(screen.queryByTestId('photo-edit')).toBeNull();
  });

  it('Cancel drops the whole selection', async () => {
    const f = fakePort();
    const { pending } = await start(f.port, ['file:///a.jpg']);
    expect(await screen.findByText('Edit photo')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('photo-edit-cancel'));
    });
    expect(await pending).toBeNull();
    expect(f.applied).toEqual([]);
  });
});
