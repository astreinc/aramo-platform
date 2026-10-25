// PLATFORM-UX-1 H-1 — one visual screen-state: how to put the design file into it
// (reference) and how to put the build into it (actual).

import type { Locator, Page } from '@playwright/test';

import type { MockOptions } from '../fixtures/mock-api';
import type { ProtoProps, StudioProtoProps } from '../support/proto';
import type { CcpProtoProps } from '../support/proto-ccp';

export interface ViewportSpec {
  readonly name: '1440' | '900';
  readonly width: number;
  readonly height: number;
}

export const VIEWPORTS: readonly ViewportSpec[] = [
  { name: '1440', width: 1440, height: 900 },
  { name: '900', width: 900, height: 900 },
];

export interface Mask {
  /** The region in the DESIGN FILE (painted into the reference at capture). */
  readonly proto?: (page: Page) => Locator;
  /** The region in the BUILD. Both regions are painted in the build image too. */
  readonly build: (page: Page) => Locator;
  /** The DIVERGENCES.md entry id that sanctions it (e.g. "DV-03"). */
  readonly divergence: string;
  /**
   * Extend the region to the bottom of the viewport (same x-range): for a
   * sanctioned divergence that legitimately changes the region's HEIGHT, so the
   * content below it in the same column shifts (e.g. a longer real enum list).
   */
  readonly toBottom?: boolean;
  /** Measure the TEXT extent (a DOM Range over the contents), not the element box. */
  readonly textBox?: boolean;
  /** Grow the region by this many px on the right (both sides), for a swapped text of a different length. */
  readonly padRight?: number;
  /** Grow the design-file region by this many px on the left. */
  readonly padLeft?: number;
  /** Grow the design-file region by this many px at the bottom (a reworded copy block). */
  readonly padBottom?: number;
  /** Grow the design-file region by this many px at the top. */
  readonly padTop?: number;
  /** Apply at one viewport only (default: both). */
  readonly viewport?: ViewportSpec['name'];
}

export interface ScreenState {
  /** Snapshot name: kebab-case; the file is `<name>-<viewport>.png`. */
  readonly name: string;
  readonly proto: {
    /**
     * The design file: Platform Admin.dc.html (default) or Template Studio.dc.html
     * (the template library and the Studio, handoff §10).
     */
    readonly file?: 'admin' | 'studio' | 'ccp';
    readonly props?: ProtoProps;
    /** CCP-B1: Commercial Control Plane v1.0.dc.html props (persona, bootstrap, demoState). */
    readonly ccp?: CcpProtoProps;
    /** Template Studio.dc.html props (persona manager / reader). */
    readonly studio?: StudioProtoProps;
    /** Route deep link (`#tenants`). */
    readonly hash?: string;
    /** setState patch applied after load (route, ids, tabs, filters…). */
    readonly state?: Record<string, unknown>;
    /** Body run against the logic instance `c` (open a dialog, etc.). */
    readonly call?: string;
    /** Extra page actions (clicks, typing) after state + call. */
    readonly act?: (page: Page) => Promise<void>;
  };
  readonly build: {
    readonly path: string;
    /** A function gives each test its own (stateful) mock. */
    readonly mock?: (MockOptions & { clock?: string }) | (() => MockOptions & { clock?: string });
    readonly act?: (page: Page) => Promise<void>;
  };
  readonly masks?: readonly Mask[];
  /** Restrict to some viewports (default: both). */
  readonly viewports?: readonly ViewportSpec['name'][];
  /**
   * A state whose pixels come from a FROZEN shared component the build may not
   * restyle (brief "Frozen areas"). The reference is still captured, but the
   * build is asserted on `frozenCheck` (copy/state) instead of pixels, and the
   * pixel gap is reported. The string is the DIVERGENCES.md id.
   */
  /**
   * Max differing pixels for this state only, when its text rasterises
   * differently on every run (anti-aliasing per directive §3). Each use is listed
   * in DIVERGENCES.md "Anti-aliasing allowances". Default: the global 25.
   */
  readonly aaAllowance?: number;
  readonly frozen?: string;
  readonly frozenCheck?: (page: Page) => Promise<void>;
  /**
   * Blur the focused element before the screenshot (both sides). For dialogs:
   * the build moves focus to the first field on open (WCAG 2.4.3); the design
   * file models no focus, so the static dialog image is taken unfocused
   * (DIVERGENCES.md DV-10). The keyboard suite asserts the focus itself.
   */
  readonly blur?: boolean;
  /** Rail collapsed by the operator (both sides). */
  readonly railCollapsed?: boolean;
  /**
   * CCP-B1: compare ONE element instead of the frame (both sides' locators; the
   * images are element screenshots). For a region whose surroundings carry a
   * sanctioned divergence that shifts it (the rail's Commercial group).
   */
  readonly element?: { readonly proto: (page: Page) => Locator; readonly build: (page: Page) => Locator };
}
