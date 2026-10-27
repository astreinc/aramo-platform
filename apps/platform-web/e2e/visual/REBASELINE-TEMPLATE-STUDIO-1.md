# TEMPLATE-STUDIO-1 — Outline-label re-baseline manifest (2026-10-27)

PO/Lead scope ruling 2026-10-27, item 4 (handoff "Template Studio (Organization)" §3,
"Labels are readable text"): the shared Studio Outline shows each variable by its
catalog label ("Dear First name,") instead of the raw `{{key}}` token that the
pinned design file (`Template Studio.dc.html`) draws. The change is presentation
only (the stored HTML is unchanged — asserted by the platform and org unit specs).

The parity gate was run BEFORE re-recording (`PW_STATE=studio`, default retries):
23 of 58 studio tests failed. For each failure the last attempt's diff image was
measured (red = differing pixel under threshold 0.2). Re-recorded ONLY the 21
states whose differing pixels lie inside the Outline panel (x 236–510 at 1440 —
the panel between the rail and the canvas; x 64–336 for the 900px overlay) and
come from the label change. Each of them also carries one isolated pixel at the
env bar (x 1285, y 14 at 1440; x 745, y 14 at 900) — glyph anti-aliasing noise,
far below the frame's 25-pixel allowance, present in every run.

NOT re-recorded (pre-existing failures, unrelated to the Outline):
`studio-preview-zoom @900` (24 differing px in the preview + 37 at the top bar)
and `studio-compare-changes @1440` (top-bar row, y 63–71).

After re-recording, the gate: 56 passed, 2 failed (exactly the two above).

| State | Viewport | Outline-panel bbox (x, y) | Differing px in panel | Outside panel |
|---|---|---|---|---|
| studio | 1440 | 293–489, 216–633 | 1034 | 1 (AA, env bar) |
| studio-block-menu | 1440 | 293–489, 216–633 | 1034 | 1 (AA, env bar) |
| studio-block-selected | 1440 | 293–489, 216–633 | 1034 | 1 (AA, env bar) |
| studio-checks | 1440 | 293–489, 216–633 | 1034 | 1 (AA, env bar) |
| studio-checks-ready | 1440 | 293–488, 187–227 | 504 | 1 (AA, env bar) |
| studio-drag | 1440 | 293–489, 216–633 | 1034 | 1 (AA, env bar) |
| studio-float-toolbar | 1440 | 293–489, 216–633 | 1034 | 1 (AA, env bar) |
| studio-more-menu | 1440 | 293–489, 216–633 | 1034 | 1 (AA, env bar) |
| studio-preview | 1440 | 293–489, 216–633 | 1034 | 1 (AA, env bar) |
| studio-preview-plain | 1440 | 293–489, 216–633 | 1031 | 1 (AA, env bar) |
| studio-preview-zoom | 1440 | 293–489, 216–633 | 1034 | 1 (AA, env bar) |
| studio-properties | 1440 | 293–489, 216–633 | 1034 | 1 (AA, env bar) |
| studio-publish-dialog | 1440 | 293–488, 187–227 | 294 | 0 |
| studio-saved | 1440 | 293–489, 216–633 | 1034 | 1 (AA, env bar) |
| studio-saving | 1440 | 293–489, 216–633 | 1034 | 1 (AA, env bar) |
| studio-shortcuts | 1440 | 293–437, 216–632 | 472 | 0 |
| studio-slash-menu | 1440 | 293–489, 216–662 | 1034 | 1 (AA, env bar) |
| studio-unsaved | 1440 | 293–489, 216–633 | 1034 | 1 (AA, env bar) |
| studio-var-popover | 1440 | 293–489, 216–662 | 1034 | 1 (AA, env bar) |
| studio-withdrawal-pending | 1440 | 293–483, 261–301 | 890 | 1 (AA, env bar) |
| studio-left-overlay | 900 | 121–317, 215–632 | 1034 | 1 (AA, env bar) |

These 21 images are now BUILD recordings in the Outline region, not design-file
captures (DIVERGENCES.md DV-32). Re-running `nx run aramo-platform-web:e2e-visual-reference`
would restore the design file's `{{key}}` outline and fail them again; re-record them
the same way (`--update-snapshots -g` on exactly these states) after any recapture.
