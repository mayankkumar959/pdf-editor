# Codebase review — 9 October 2026

Reviewed the React interface, PDF parsing/font mapping, geometry, native and rendered-page exports, preview lifecycle, history, file handling, styles, build configuration, local PDF.js assets and verification scripts.

## Fixed

- Font size and box dimensions now update while typing. Ctrl+S includes pending numeric changes, and typing keeps focus in the numeric field.
- Merely focusing or leaving a dimension field no longer rounds and changes a previously precise box size.
- Underline/strikethrough-only edits retain original PDF text instructions and every TJ spacing adjustment. The regression fixture retains its exact 80.388 pt width and glyph positions.
- Alignment and resizing account for enlarged neighboring text. Adjacent lines requested at 50 pt fit safely while preserving both original baselines; the regression export has a 2.856 pt gap between their bounds.
- Changing a selection validates affected committed edits. Invalid layouts retain selectable targets rather than crashing the interface.
- The active preview worker stays alive until its replacement is ready. Document replacement, cancellation, unmount and rendered-page export failures release owned resources.
- File read failures produce an actionable error. A corrupt PDF upload keeps the previous document usable.
- The brand no longer reloads the editor and discards changes when clicked.
- Canvas rendering caps resolution at 8192 pixels per edge and 20 million pixels to limit memory use at large zoom levels.
- Enabled TypeScript strict checks for application and build configuration.

## Verification

- `npm run build`: passed, including strict TypeScript checks.
- `npm run lint`: passed.
- `npm run verify:editor`: passed. Covers real double-click selection at 25/100/200% zoom, inline edits, bold and subset fonts, text deletion, font/color/decoration formatting, resizing, safe fitting, columns, crop/rotation, PDF spacing and cursor restoration, repeated shared forms, page navigation, Undo/Redo, actual downloads and reopening. Added regressions for the fixes above. No uncaught browser exceptions.
- `npm run verify:production`: passed against the built application on port 4173. Verified embedded-font upload, complex-stream editing, download, reopening, preserved bold/underline, and no failed asset requests or uncaught browser exceptions.
- All 198 bundled PDF.js font/CMap/WASM files match the installed package by SHA-256.

Detailed generated reports: `test-results/verification.json` and `test-results/production-verification.json`.

## Added document tools

The subsequent feature update adds movable/resizable multiline text, images, drawn/uploaded visual signatures, ordered merging, page extraction and splitting to a ZIP. Build, lint, the existing editor regressions, `verify:tools` and the extended production verification passed. Export tests cover all four rotations with cropped pages, exact added-text baselines, image pixel orientation, real pointer gestures, pending objects in downloads, merge order and preservation of edited pages in split outputs. The split archive also opens using .NET's independent ZIP reader. See `test-results/tools-verification.json` and README usage/limits.

## Remaining limits

- `npm audit --omit=dev --json` could not reach the registry audit endpoint in this environment. Dependency vulnerability status is unverified.
- Vite reports a large main bundle (about 1.13 MB before gzip). The production build works; initial loading could benefit from code splitting.
- Verification used generated PDFs, not the user's original PDF. These checks do not establish that every PDF structure is handled perfectly.
- Scanned pages require OCR, which is not implemented. Fonts lacking required characters or style variants can require substitution or reject unsupported text. Complex-stream fallback rasterizes background graphics and may approximate spacing.
