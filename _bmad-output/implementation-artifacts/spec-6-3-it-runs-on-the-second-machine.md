---
title: 'It runs on the second machine'
type: 'feature'
created: '2026-08-28'
status: 'done'
route: 'one-shot'
---

# It runs on the second machine

## Intent

**Problem:** Every prior cold-start proof (Story 6.1) ran on the build machine — Windows, one
Node install, one global npm root, one Python interpreter. The story was un-deferred on
28 Aug 2026 because the repository was about to be handed to a teammate with a GPU laptop, and
a fresh `DSH_HOME` on the build machine does not answer "does this survive contact with a
machine nobody has tuned by hand?"

**Approach:** Ran the documented command on the teammate's own laptop — Linux under WSL2,
GTX 1650 Ti, 4 GB (same GPU class as the build machine, confirmed with `nvidia-smi`). `npm
start` was run directly (the README already documents this as the cross-platform entry point;
`run.bat` is Windows-only and inapplicable here), reached the workbench, and the first demo
beat was verified against a real running session: tab title "Blind Flange", no dialog on load,
the Canary control denies on press and turns its indicator red, and the session's Egress
monitor shows a real audit log — timestamp, tool name (`bf_canary`), refused target — matching
Story 2.4's shape exactly. The provider disclosure read "Replay — authored responses" and the
routing chip named a real fleet member, both working as specified.

`npm run doctor` and `npm test` surfaced three real second-machine findings, none of them
about whether the install itself was correct:

1. **A false negative in `doctor.mjs`.** Its profile-wiring check forced backslashes onto the
   stored `link:` path before calling `resolve()` — harmless on Windows, but on POSIX
   `path.resolve()` never treats `\` as a separator, so the check could never pass on
   Linux/macOS regardless of whether the install was wired correctly. Fixed by dropping the
   forced conversion — `path.resolve()` already normalizes separators correctly per platform
   on its own.
2. **A platform-specific licence-evidence gap for libvips.** `docs/licence-decisions.json`'s
   only recorded evidence was `@img/sharp-win32-x64/package.json`. `sharp` resolves a different
   native binary per platform — on Linux it's `@img/sharp-linux-x64` (Apache-2.0) plus a
   separate `@img/sharp-libvips-linux-x64` package (LGPL-3.0-or-later) — so that evidence path
   never exists here. Fixed by evidencing against `@img/sharp-wasm32` instead: sharp's
   platform-independent fallback build, installed on every machine regardless of OS, carrying
   the same combined licence string, confirmed present on both the build machine and this one.
3. **A real licence-classification gap for FFmpeg inside `opencv-python`, found by measuring
   rather than assuming.** The existing decision was `mitigated` — "measured not loaded" on
   Windows, where FFmpeg ships as a lazily-loaded video-I/O plugin DLL that a pure-OCR pass
   never touches. On Linux this is not true: `ldd` on `cv2.abi3.so` lists
   `libavcodec`/`libavformat`/`libavutil`/`libswscale` as direct `NEEDED` entries, and a running
   `python -c "import cv2"` process confirmed all four mapped into `/proc/self/maps`
   immediately — genuinely linked the moment the module loads, not lazily avoided. Reclassified
   to `disclosed`, using the same LGPL compliance reasoning already accepted for libvips
   (dynamic linking, notice, ability to relink).

`docs/licence-audit.md` was regenerated (`npm run licence-audit -- --write`) so the tracked
report matches the corrected decisions.

## What was NOT a bug

- `npm run kiosk`'s fullscreen auto-launch is hardcoded to Windows browser install paths
  (`C:/Program Files/...`). On this machine none exist, so it degrades to its own documented
  fallback — print the URL, open manually, press F11 — rather than crashing. `npm start` (used
  here) doesn't go through this path at all.
- The four Python-ecosystem licence-audit failures seen before `npm run setup-ingestion` was
  run (`opencv-python`, `onnxruntime`, `reportlab`, `pypdfium2` evidence, all under
  `{site-packages}`) were expected: that service is documented as optional and its evidence
  lives inside its own venv. Installing it (`npm run setup-ingestion`) resolved all four; its
  own 9-test suite passed cleanly under Python 3.14.4 (RapidOCR/onnxruntime CPU inference, no
  CUDA used — model plane is `replay` in Phase 0, GPU-class parity is for a future stretch
  goal, not a current runtime need).

## Suggested Review Order

- The doctor fix: [`scripts/doctor.mjs:114`](../../scripts/doctor.mjs#L114) — one line removed,
  no behaviour change on Windows, a real fix on POSIX.
- The libvips evidence narrowing:
  [`docs/licence-decisions.json`](../../docs/licence-decisions.json) — search `sharp-wasm32`.
- The FFmpeg reclassification, same file — search `disclosed` under the `FFmpeg` bundled
  component. The `reason` field carries the `ldd` output and the `/proc/self/maps` measurement
  that justified it.
- The regenerated report: [`docs/licence-audit.md`](../../docs/licence-audit.md).

## Verification

Run on this second machine (Linux/WSL2, GTX 1650 Ti 4GB), 28 August 2026:

- `npm run doctor`: **16/16 checks passed** (toolchain, profile wiring ×2, patch layers ×2,
  workspace, the seal ×2, 230 plugin tests, the licence audit, the ingestion service ×3,
  workbench reachable).
- `npm test`: 230/230 plugin tests pass; licence audit passes — 489 components enumerated,
  every one decided, every evidence path resolves on this machine.
- `npm run setup-ingestion`: installed cleanly, `shapely` confirmed absent, the service's own
  9-test suite passed.
- First demo beat, verified against a live session via Chrome DevTools automation: tab title
  "Blind Flange", no dialog on load, Canary press denied (indicator turns red), Egress monitor
  reads a real audit log — four denied `bf_canary` attempts, each with timestamp and refused
  target `https://example.com/blind-flange-canary`. Provider disclosure read "Replay —
  authored responses"; the routing chip named a real fleet member.
- Screenshots: `docs/screenshots/6-3-second-machine-before-canary.png`,
  `6-3-second-machine-canary-denied.png`, `6-3-second-machine-egress-audit.png`.
- A separate clean `git clone` of the pushed commit, in a sibling directory outside this
  checkout, also reached the running workbench via `npm start` — the literal "clean clone"
  the acceptance criterion names, not an approximation of it.
