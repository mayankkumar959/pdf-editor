# Folio PDF Studio

A private React + TypeScript PDF editor. Documents are processed in the browser and are never uploaded to a server.

## Run

```sh
npm install
npm run dev
```

Open http://localhost:5173. Drop a PDF onto the workspace, or use the built-in sample.

## Editing

Double-click existing text on a page to select the entire line and open its inline editor. A single click highlights the line without intercepting your next click. The right panel offers a larger text field and shows the original font. Press Enter or click Apply edit. Escape discards the current draft. Download PDF also applies a valid pending draft before saving.

Use page thumbnails, zoom, fit-to-width, undo and redo to review changes. Ctrl+S downloads; Ctrl+Z and Ctrl+Shift+Z undo and redo outside text fields.

The selected line has Bold, Italic, Underline, Strikethrough, font size (1–300 pt) and text colour controls. Existing weight, slant, size and colour are reflected in the panel. Ctrl+B, Ctrl+I and Ctrl+U toggle formatting on the selected line. Formatting participates in Apply, Download, Discard, Restore original and Undo/Redo along with text and box size. It applies to the whole selected line.

Bold/italic use an available variant from the original PDF font family when possible, otherwise a compatible standard PDF font; the panel identifies family substitutions. Formatting is written into PDF text instructions, and underline/strikethrough are real vector strokes. Font and colour state are restored explicitly so following text keeps its position and appearance. Decorations created by this editor survive reopening and are removed from the PDF when toggled off. Font sizes fit to the box, neighboring lines and page bounds; widen the box when the requested size cannot fit.

Select a line to reveal resize handles on its right edge, bottom edge and corner. Drag the right edge to give a longer name more room; the original font size returns as soon as the text fits. The Width and Height fields allow exact sizes in PDF points. Numeric changes are reflected immediately and included by Ctrl+S without leaving the field. Focusing a rounded field alone does not change the saved dimensions. Handles support arrow keys (5 pt, or 20 pt with Shift), touch dragging and zoomed/rotated pages. Boxes stop at the page edge and nearby text. Apply edit or Download commits both the text and box size; Discard changes and Escape restore the previous size. Undo/redo includes committed resizing. Height expands the selection area; editing remains one line at its original baseline.

Every extracted text line opens for editing, including bold text. The normal exporter modifies original PDF text instructions, reusing their fonts, colour and baseline. Longer replacements automatically fit inside their original line, nearby text boundaries and the visible page. Character and word spacing scale with the fitted text and are restored afterward. Cursor compensation keeps later text in place, and shared Form XObjects are cloned per edited instance.

For text that cannot be linked to whole native operations, the exporter rebuilds that page with a high-resolution image of its background and recovered text as selectable vector text. It removes the old glyphs using a text-free render, preserving coloured backgrounds instead of applying white rectangles. Fonts are recovered separately from stream parsing. Original fonts are reused when their encodings support the replacement; otherwise the panel identifies a compatible font with matching bold/italic style. Reopened exports can be edited again. This fallback rasterizes background graphics and may approximate spacing or unsupported font details; other pages keep the normal native export.

## New text, images and signatures

Use **New text** to insert a movable, multiline box. Double-click it to type on the page, or use the properties panel. Choose Helvetica/Arial, Times or Courier, size, colour, bold, italic, underline and strikethrough. Text wraps to the box and its height grows when needed; text that cannot fit is reported before export. New boxes support characters available in these standard fonts.

Use **Image** for PNG, JPEG or WebP files. **Signature** opens a drawing pad for mouse, touch or pen input, or lets you upload a signature image. Drawn signatures have transparent backgrounds; they are visual signatures, not certificate-based digital signatures.

Drag new objects to move them and use the corner handle to resize. Position and size fields use PDF points. Image resizing preserves proportions; objects stay within the visible page, including rotated/cropped pages. Arrow keys move selected objects by 1 pt, or 10 pt with Shift. Apply, Discard, Delete and Undo/Redo include object changes. Download and Ctrl+S include pending valid changes. Place objects where you want them; they may overlap existing page content if positioned there.

New objects are kept as editable objects during the current session. Exported text remains real selectable PDF text and can be edited again after reopening; images/signatures are embedded in the PDF. Reopening or merging does not restore their original object selection controls.

## Merge, split and extract

**Merge PDFs** accepts multiple PDFs, supports file reordering/removal and includes the current document's edits and objects. It opens the combined result as a new document. The welcome screen also allows merging without opening a document first.

**Split / extract** can download selected pages as one PDF (`1-3, 5`), split groups into separate PDFs (`1-2; 3-5`), or save every page separately. Multiple outputs are delivered in a single ZIP. Page order, rotation, images and current edits are preserved. Processing stays in the browser.

## Supported documents and limits

- Standard PDF fonts and embedded fonts with usable encodings, including subset CID fonts, are supported.
- An embedded subset may contain only characters used when the PDF was created. A compatible font is offered automatically when it can encode a replacement; the panel identifies the substitution. Characters unavailable in both fonts are reported before applying or downloading.
- Scanned image pages require OCR, which is not included.
- Password-protected documents must be unlocked first.
- Complex text structures, Type 3 fonts and inline-image streams use the rendered-page fallback instead of locking the editor. Image-only scanned pages still require OCR.
- Edits stay in memory until downloaded. Text stays anchored to its original baseline; long replacements fit automatically rather than growing into adjacent content or beyond the page. Exceptionally long text that would need a font smaller than 1 pt is rejected with a clear message.

## Verification

```sh
npm run build
npm run lint
npm run verify:editor
npm run verify:tools
```

After building and running the editor verification to generate fixtures, keep the same dedicated Chrome instance running. `npm run preview -- --host 127.0.0.1 --port 4173` and `npm run verify:production` check the built application: upload, fallback editing, new text, images, drawn signature, real downloads/reopening, merge/extract, formatting and failed asset requests. Run browser scripts one at a time.

The browser verification script uses Chrome DevTools directly, with no browser automation dependency. Start Vite on 127.0.0.1:5173 and a dedicated headless Chrome instance on port 9222 before running it. On Windows, from this project directory:

```powershell
$profilePath = Join-Path (Get-Location) '.browser-profile'
& 'C:/Program Files/Google/Chrome/Application/chrome.exe' --headless=new --disable-gpu --remote-debugging-port=9222 "--user-data-dir=$profilePath" about:blank
```

The script generates its own PDFs. It checks real pointer double-clicks at 25%, 100% and 200% zoom, full-line selection and focus, upload, inline editing, automatic fitting of long text, preview/export measurement agreement, columns, page edges, character/word spacing restoration, changes across pages, undo/redo, actual downloads containing pending edits, standard and embedded subset fonts, unchanged adjacent text, text deletion, cropped/rotated pages, and isolated edits to repeated shared forms. It also edits bold text in a previously unsupported inline-image stream, verifies old glyphs disappear both from extraction and rendered pixels, and reopens and edits the saved PDF. Resizing checks include real pointer dragging at 50% zoom, corner resizing, original font size restoration, page/neighbor limits, undo/redo, native and fallback export, and the actual downloaded font size. Screenshots, sample PDFs and the verification report are written to test-results/.

Formatting verification checks actual bold/italic PDF fonts, requested size, RGB colour, baseline and neighboring text preservation, vector decoration creation/removal, fallback formatting, toolbar state, Undo/Redo, and an actual download reopened with all styles intact. Audit regressions preserve original TJ kerning when only decorations change, prevent overlap between adjacent enlarged lines, save pending numeric values through Ctrl+S, avoid accidental size changes on focus/blur, and exercise rapid Undo/Redo without destroying the active preview worker. TypeScript strict checking is enabled for both app and build configuration.

`verify:tools` checks multiline new text, formatting, actual pointer movement/resizing at 50% zoom, object Undo/Redo, uploaded images, drawn signatures and pending edits in real downloads. It measures added-text baselines and rendered image pixels on all four page rotations with CropBoxes. It also checks merge order, selected-page ordering, invalid page ranges, separate PDF outputs in a ZIP and preservation of added content. Results are in `test-results/tools-verification.json`.

PDF.js font, CMap and WASM assets are bundled under public/pdfjs/ so document rendering does not depend on a third-party CDN. Refresh those folders from node_modules/pdfjs-dist after upgrading PDF.js.
#   p d f - e d i t o r  
 