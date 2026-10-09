import * as pdfjs from 'pdfjs-dist'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts, decodePDFRawStream, rgb } from 'pdf-lib'
import type { PDFFont } from 'pdf-lib'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

export const pdfOptions = {
  cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`, cMapPacked: true,
  standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
  wasmUrl: `${import.meta.env.BASE_URL}pdfjs/wasm/`,
}

type Token = { start: number; end: number; value: string; bytes?: Uint8Array; children?: Token[] }
type Operation = { start: number; end: number; command: string; args: Token[] }
type FontInfo = { name: string; identity: string; resource: string; codes: Map<string, string>; widths: Map<string, number>; standard?: PDFFont; size: number; spacing: number; wordSpacing: number; dict?: PDFDict }
type StreamNode = { key: string; source: string; stream: PDFRawStream; operations: Operation[]; resources: PDFDict; children: Map<number, StreamNode> }
type Run = { id: string; node: string; operation: Operation; font: FontInfo; renderedFont: string; bytes: Uint8Array; text: string; advance: number }
export type TextFormat = { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; fontSize?: number; color?: string }
export type TextFormats = Record<string, TextFormat>
export type TextBlock = { id: string; text: string; font: string; item: TextItem; runs: string[]; editable: boolean; native: boolean; sourceFont?: FontInfo; fallbackFont: FontInfo; variants: FontInfo[]; originalFormat: TextFormat }
export type PageModel = { blocks: TextBlock[]; width: number; height: number; rotation: number; viewportTransform: number[]; ascents: Record<string, number>; descents: Record<string, number>; runs: Run[]; roots: StreamNode[] }
export type EditorDocument = { bytes: Uint8Array; proxy: pdfjs.PDFDocumentProxy; pages: PageModel[] }
export type Edits = Record<string, string>
export type TextBoxSize = { width: number; height: number }
export type TextBoxes = Record<string, TextBoxSize>

const name = (value: string) => PDFName.of(value)
const binary = (bytes: Uint8Array) => Array.from(bytes, byte => String.fromCharCode(byte)).join('')
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
const compact = (value: string) => value.normalize('NFKC').replace(/\s/g, '')
const decodeName = (value: string) => value.replace(/#([\da-f]{2})/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
const weight = (font: string) => /bold|black|heavy|demi/i.test(font)
const slant = (font: string) => /italic|oblique/i.test(font)
const familyKey = (font: string) => font.replace(/bold|italic|oblique|roman|regular|demi|black|heavy|psmt|mt|[ _-]/gi, '').toLowerCase()
const colourCommand = (colour: string) => [1, 3, 5].map(offset => (parseInt(colour.slice(offset, offset + 2), 16) / 255).toFixed(6)).join(' ')

// A lexical reader keeps string/array boundaries intact, including escaped parentheses.
function tokenize(source: string): Token[] {
  let position = 0
  function next(): Token | undefined {
    while (position < source.length) {
      if (/\s|\0/.test(source[position])) { position++; continue }
      if (source[position] === '%') { while (position < source.length && !/[\r\n]/.test(source[position])) position++; continue }
      break
    }
    if (position >= source.length) return
    const start = position
    const ch = source[position++]
    if (ch === '(') {
      const bytes: number[] = []
      let depth = 1
      while (position < source.length && depth) {
        let c = source[position++]
        if (c === '\\') {
          c = source[position++]
          if (/[0-7]/.test(c)) {
            let octal = c
            for (let i = 0; i < 2 && /[0-7]/.test(source[position] ?? ''); i++) octal += source[position++]
            bytes.push(parseInt(octal, 8) & 255)
          } else if (c === '\r' || c === '\n') { if (c === '\r' && source[position] === '\n') position++ }
          else bytes.push(({ n: 10, r: 13, t: 9, b: 8, f: 12 } as Record<string, number>)[c] ?? c.charCodeAt(0))
        } else {
          if (c === '(') depth++
          if (c === ')') depth--
          if (depth) { if (c === '\r') { if (source[position] === '\n') position++; c = '\n' }; bytes.push(c.charCodeAt(0)) }
        }
      }
      if (depth) throw new Error('This PDF has an invalid text stream.')
      return { start, end: position, value: source.slice(start, position), bytes: new Uint8Array(bytes) }
    }
    if (ch === '<' && source[position] !== '<') {
      let value = ''
      while (position < source.length && source[position] !== '>') value += source[position++]
      position++
      value = value.replace(/\s/g, '')
      if (value.length % 2) value += '0'
      return { start, end: position, value: source.slice(start, position), bytes: Uint8Array.from(value.match(/../g) ?? [], pair => parseInt(pair, 16)) }
    }
    if (ch === '[') {
      const children: Token[] = []
      while (position < source.length) { const child = next(); if (!child || child.value === ']') break; children.push(child) }
      return { start, end: position, value: source.slice(start, position), children }
    }
    if ('<>]'.includes(ch)) { if (source[position] === ch && ch !== ']') position++; return { start, end: position, value: source.slice(start, position) } }
    while (position < source.length && !/[\s\0()[\]<>/%]/.test(source[position])) position++
    return { start, end: position, value: source.slice(start, position) }
  }
  const result: Token[] = []
  while (position < source.length) { const token = next(); if (token) result.push(token) }
  return result
}

function operations(source: string): Operation[] {
  const result: Operation[] = []
  let args: Token[] = []
  for (const token of tokenize(source)) {
    if (!token.bytes && !token.children && !token.value.startsWith('/') && /^(?:[A-Za-z][A-Za-z0-9*]*|['"])$/.test(token.value) && !['true', 'false', 'null'].includes(token.value)) {
      // Inline image binary needs the rendered-page export strategy.
      if (token.value === 'BI') throw new Error('Inline image stream')
      result.push({ start: args[0]?.start ?? token.start, end: token.end, command: token.value, args })
      args = []
    } else args.push(token)
  }
  return result
}

function cmap(font: PDFDict): Map<string, string> {
  const result = new Map<string, string>()
  const stream = font.lookup(name('ToUnicode'))
  if (!(stream instanceof PDFRawStream)) return result
  const source = binary(decodePDFRawStream(stream).decode())
  const decode = (code: string) => {
    let text = ''
    for (let i = 0; i < code.length; i += 4) text += String.fromCharCode(parseInt(code.slice(i, i + 4), 16))
    return text
  }
  for (const section of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of section[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi)) result.set(decode(pair[2]), pair[1].toUpperCase())
  }
  for (const section of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of section[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>\s*(<([\da-f]+)>|\[([^\]]*)\])/gi)) {
      const first = parseInt(range[1], 16), last = parseInt(range[2], 16)
      if (last - first > 65536) continue
      const entries = range[5]?.match(/<([\da-f]+)>/gi)
      for (let code = first; code <= last; code++) {
        const unicode = entries ? entries[code - first]?.slice(1, -1) : (parseInt(range[4], 16) + code - first).toString(16).padStart(range[4].length, '0')
        if (unicode) result.set(decode(unicode), code.toString(16).padStart(range[1].length, '0').toUpperCase())
      }
    }
  }
  return result
}

async function getFont(doc: PDFDocument, dict: PDFDict | undefined): Promise<FontInfo> {
  const baseName = dict?.lookup(name('BaseFont'))
  const base = baseName instanceof PDFName ? baseName.decodeText().replace(/^[A-Z]{6}\+/, '') : 'Original font'
  // Equal definitions can have distinct PDF.js font IDs as well as distinct
  // resource names. Compare dictionary entries, not resource/object identity.
  const definition = dict?.entries().map(([key, value]) => `${key.toString()} ${value.toString()}`).sort().join('\n') ?? ''
  const info: FontInfo = { name: base, identity: definition, resource: '', codes: dict ? cmap(dict) : new Map(), widths: new Map(), size: 12, spacing: 0, wordSpacing: 0, dict }
  if (Object.values(StandardFonts).includes(base as StandardFonts)) {
    info.standard = await doc.embedFont(base as StandardFonts)
    // WinAnsi is explicit in pdf-lib output; the unmodified default encoding is safe for ASCII.
    const encoding = dict?.lookup(name('Encoding'))
    const winAnsi = encoding?.toString() === '/WinAnsiEncoding'
    const ascii = !encoding || encoding.toString() === '/StandardEncoding'
    for (let code = 32; code < (winAnsi ? 256 : ascii ? 127 : 32); code++) {
      const char = new TextDecoder('windows-1252').decode(new Uint8Array([code]))
      try { info.standard.encodeText(char); info.codes.set(char, code.toString(16).padStart(2, '0').toUpperCase()) } catch { /* Undefined encoding slot. */ }
    }
  }
  return info
}

function bytesFor(operation: Operation): Uint8Array {
  const tokens = operation.command === 'TJ' ? operation.args[0]?.children ?? [] : operation.args.slice(-1)
  return new Uint8Array(tokens.flatMap(token => token.bytes ? Array.from(token.bytes) : []))
}

async function readPage(doc: PDFDocument, index: number): Promise<{ roots: StreamNode[]; runs: Run[] }> {
  const page = doc.getPage(index)
  const roots: StreamNode[] = [], runs: Run[] = []
  const fonts = new Map<PDFDict, FontInfo>()
  let font: FontInfo = await getFont(doc, undefined)
  const stack: FontInfo[] = []
  async function read(stream: PDFRawStream, resources: PDFDict, key: string, depth: number): Promise<StreamNode> {
    if (depth > 12) throw new Error('Nested PDF form limit')
    const source = binary(decodePDFRawStream(stream).decode())
    const node: StreamNode = { key, stream, source, operations: operations(source), resources, children: new Map() }
    for (let i = 0; i < node.operations.length; i++) {
      const op = node.operations[i]
      if (op.command === 'q') stack.push({ ...font })
      if (op.command === 'Q') font = stack.pop() ?? font
      if (op.command === 'Tf') {
        const fontsDict = resources.lookup(name('Font'))
        const fontDict = fontsDict instanceof PDFDict ? fontsDict.lookup(name(decodeName(op.args[0].value.slice(1)))) : undefined
        if (fontDict instanceof PDFDict) {
          let cached = fonts.get(fontDict)
          if (!cached) { cached = await getFont(doc, fontDict); fonts.set(fontDict, cached) }
          font = { ...cached, resource: op.args[0].value, size: Number(op.args[1].value), spacing: font.spacing, wordSpacing: font.wordSpacing }
        }
      }
      if (op.command === 'Tc') font = { ...font, spacing: Number(op.args[0].value) }
      if (op.command === 'Tw') font = { ...font, wordSpacing: Number(op.args[0].value) }
      if (op.command === '"') font = { ...font, wordSpacing: Number(op.args[0].value), spacing: Number(op.args[1].value) }
      if (['Tj', 'TJ', "'", '"'].includes(op.command)) runs.push({ id: `${key}:${i}`, node: key, operation: op, font: { ...font }, renderedFont: '', bytes: bytesFor(op), text: '', advance: 0 })
      if (op.command === 'Do') {
        const objects = resources.lookup(name('XObject'))
        const object = objects instanceof PDFDict ? objects.lookup(name(decodeName(op.args[0].value.slice(1)))) : undefined
        if (object instanceof PDFRawStream && object.dict.lookup(name('Subtype'))?.toString() === '/Form') {
          const saved = { ...font }
          const ownResources = object.dict.lookup(name('Resources'))
          node.children.set(i, await read(object, ownResources instanceof PDFDict ? ownResources : resources, `${key}/${i}`, depth + 1))
          font = saved
        }
      }
    }
    return node
  }
  const resources = page.node.Resources() ?? doc.context.obj({})
  const contents = page.node.Contents()
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) { const stream = contents.lookup(i); if (stream instanceof PDFRawStream) roots.push(await read(stream, resources, `${index}/${i}`, 0)) }
  } else if (contents instanceof PDFRawStream) roots.push(await read(contents, resources, `${index}/0`, 0))
  return { roots, runs }
}

type Glyph = { unicode: string; width: number; originalCharCode?: number; isSpace?: boolean }

export async function openDocument(bytes: Uint8Array): Promise<EditorDocument> {
  const proxy = await pdfjs.getDocument({ ...pdfOptions, fontExtraProperties: true, data: bytes.slice() }).promise
  try {
    const native = await PDFDocument.load(bytes)
    const pages: PageModel[] = []
    const fallbackFonts = new Map<StandardFonts, FontInfo>()
    for (let index = 0; index < proxy.numPages; index++) {
      const page = await proxy.getPage(index + 1)
      const [content, operators] = await Promise.all([page.getTextContent(), page.getOperatorList()])
      let roots: StreamNode[] = [], runs: Run[] = []
      try { ({ roots, runs } = await readPage(native, index)) } catch { /* Unsupported stream remains viewable. */ }
      // Recover fonts independently of the text-stream parser. Inline images,
      // partial text items and other unusual streams still have usable fonts.
      const resourceFonts: FontInfo[] = []
      const visitedResources = new Set<PDFDict>()
      async function recoverFonts(resources: PDFDict, depth = 0): Promise<void> {
        if (depth > 12 || visitedResources.has(resources)) return
        visitedResources.add(resources)
        const fonts = resources.lookup(name('Font'))
        if (fonts instanceof PDFDict) for (const [key] of fonts.entries()) {
          const dict = fonts.lookup(key)
          if (dict instanceof PDFDict) resourceFonts.push(await getFont(native, dict))
        }
        const objects = resources.lookup(name('XObject'))
        if (objects instanceof PDFDict) for (const [key] of objects.entries()) {
          const object = objects.lookup(key)
          const nested = object instanceof PDFRawStream ? object.dict.lookup(name('Resources')) : undefined
          if (nested instanceof PDFDict) await recoverFonts(nested, depth + 1)
        }
      }
      const resources = native.getPage(index).node.Resources()
      if (resources) await recoverFonts(resources)
      const shows: (Glyph | number)[][] = []
      const renderedFonts: string[] = []
      const fontStack: string[] = []
      const colorStack: string[] = [], shownColors: string[] = []
      let renderedFont = ''
      let renderedColor = '#000000'
      operators.fnArray.forEach((fn, i) => {
        if (fn === pdfjs.OPS.save || fn === pdfjs.OPS.paintFormXObjectBegin) { fontStack.push(renderedFont); colorStack.push(renderedColor) }
        if (fn === pdfjs.OPS.restore || fn === pdfjs.OPS.paintFormXObjectEnd) { renderedFont = fontStack.pop() ?? renderedFont; renderedColor = colorStack.pop() ?? renderedColor }
        if (fn === pdfjs.OPS.setFont) renderedFont = operators.argsArray[i][0]
        if (fn === pdfjs.OPS.setFillRGBColor) {
          const args = operators.argsArray[i]
          if (typeof args[0] === 'string') renderedColor = args[0]
          else renderedColor = '#' + args.slice(0, 3).map((value: number) => Math.round(value * 255).toString(16).padStart(2, '0')).join('')
        }
        if (fn === pdfjs.OPS.showText) { shows.push(operators.argsArray[i][0]); renderedFonts.push(renderedFont); shownColors.push(renderedColor) }
      })
      const aligned = shows.length === runs.length
      if (aligned) runs.forEach((run, i) => {
        run.renderedFont = renderedFonts[i]
        const glyphs = shows[i].filter((glyph): glyph is Glyph => typeof glyph !== 'number')
        run.text = glyphs.map(glyph => glyph.unicode).join('')
        const codeSize = glyphs.length ? run.bytes.length / glyphs.length : 0
        if (Number.isInteger(codeSize) && codeSize >= 1 && codeSize <= 4) glyphs.forEach((glyph, j) => {
          const code = hex(run.bytes.slice(j * codeSize, (j + 1) * codeSize))
          run.font.codes.set(glyph.unicode, code)
          run.font.codes.set(glyph.unicode.normalize('NFKC'), code)
          run.font.widths.set(code, glyph.width)
        })
        run.advance = shows[i].reduce<number>((total, glyph) => total + (typeof glyph === 'number' ? -glyph : glyph.width + 1000 * (run.font.spacing + (glyph.isSpace ? run.font.wordSpacing : 0)) / run.font.size), 0)
      })
      // PDF.js resolves resource aliases to their actual font identity. A Word
      // document may use /F1 and /F2 for the same font within one extracted line;
      // map-object identity is not evidence of a font or style change.
      const canonicalFonts = new Map<string, FontInfo>()
      for (const run of runs) {
        if (!run.renderedFont) continue
        const canonical = canonicalFonts.get(run.renderedFont)
        if (!canonical) { canonicalFonts.set(run.renderedFont, run.font); continue }
        run.font.codes.forEach((code, unicode) => canonical.codes.set(unicode, code))
        run.font.widths.forEach((width, code) => canonical.widths.set(code, width))
        run.font.codes = canonical.codes; run.font.widths = canonical.widths
      }
      let cursor = 0
      const blocks: TextBlock[] = []
      const items = content.items.filter((item): item is TextItem => 'str' in item && !!item.str.trim())
      for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        let item = items[itemIndex]
        let target = compact(item.str)
        let match: Run[] = []
        let lastItemIndex = itemIndex
        if (aligned) {
          // Match full text operations only. Partial-operation edits could erase adjacent text.
          for (let start = cursor; start < Math.min(runs.length, cursor + 30); start++) {
            target = compact(item.str); lastItemIndex = itemIndex
            const candidates: Run[] = []
            let text = ''
            for (let end = start; end < runs.length; end++) {
              candidates.push(runs[end]); text += compact(runs[end].text)
              // PDF.js can split a single operation around large spaces. Reunite those items.
              while (text.startsWith(target) && text.length > target.length && lastItemIndex + 1 < items.length) {
                const nextItem = items[lastItemIndex + 1]
                if (nextItem.fontName !== item.fontName || Math.abs(nextItem.transform[5] - item.transform[5]) > 0.1 || Math.abs(nextItem.transform[1] - item.transform[1]) > 0.1) break
                target += compact(nextItem.str); lastItemIndex++
              }
              if (text === target) { match = candidates; cursor = end + 1; break }
              if (!target.startsWith(text)) break
            }
            if (match.length) break
          }
        }
        if (match.length && lastItemIndex > itemIndex) {
          const last = items[lastItemIndex]
          item = { ...item, str: match.map(run => run.text).join(''), width: Math.max(item.width, Math.hypot(last.transform[4] - item.transform[4], last.transform[5] - item.transform[5]) + last.width) }
          itemIndex = lastItemIndex
        }
        const sameFont = match.length > 0 && match.every(run => (run.renderedFont && run.renderedFont === match[0].renderedFont) || (run.font.identity && run.font.identity === match[0].font.identity))
        const nativeEdit = !!sameFont && match[0].font.dict?.lookup(name('Subtype'))?.toString() !== '/Type3' && item.dir !== 'ttb' && !content.styles[item.fontName]?.vertical
        const rendered = page.commonObjs.has(item.fontName) ? page.commonObjs.get(item.fontName) : undefined
        const recovered = resourceFonts.filter(font => font.dict?.lookup(name('BaseFont')) instanceof PDFName && (font.dict!.lookup(name('BaseFont')) as PDFName).decodeText() === rendered?.name)
        const sourceFont = match[0]?.font ?? runs.find(run => run.renderedFont === item.fontName)?.font ?? (recovered.length === 1 ? recovered[0] : undefined)
        if (sourceFont && !match.length) shows.forEach((glyphs, i) => {
          if (renderedFonts[i] !== item.fontName) return
          const codeSize = sourceFont.dict?.lookup(name('Subtype'))?.toString() === '/Type0' ? 4 : 2
          for (const glyph of glyphs) {
            if (typeof glyph === 'number' || glyph.originalCharCode === undefined) continue
            const code = glyph.originalCharCode.toString(16).padStart(codeSize, '0').toUpperCase()
            sourceFont.codes.set(glyph.unicode, code); sourceFont.codes.set(glyph.unicode.normalize('NFKC'), code)
            sourceFont.widths.set(code, glyph.width)
          }
        })
        const fontName = sourceFont?.name ?? rendered?.name ?? content.styles[item.fontName]?.fontFamily ?? 'Original font'
        const bold = !!rendered?.bold || /bold|black|heavy|demi/i.test(fontName)
        const italic = !!rendered?.italic || /italic|oblique/i.test(fontName)
        const serif = /times|georgia|serif|cambria|garamond/i.test(fontName) && !/sans/i.test(fontName)
        const mono = /courier|mono|consolas/i.test(fontName)
        const fallbackName = serif ? (bold ? italic ? StandardFonts.TimesRomanBoldItalic : StandardFonts.TimesRomanBold : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman) : mono ? (bold ? italic ? StandardFonts.CourierBoldOblique : StandardFonts.CourierBold : italic ? StandardFonts.CourierOblique : StandardFonts.Courier) : (bold ? italic ? StandardFonts.HelveticaBoldOblique : StandardFonts.HelveticaBold : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica)
        let fallbackFont = fallbackFonts.get(fallbackName)
        if (!fallbackFont) {
          fallbackFont = await getFont(native, native.context.obj({ BaseFont: name(fallbackName), Encoding: name('WinAnsiEncoding') }))
          fallbackFonts.set(fallbackName, fallbackFont)
        }
        const variants: FontInfo[] = []
        const standardVariants = serif ? [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic] : mono ? [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique] : [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique]
        const candidates = resourceFonts.filter(font => familyKey(font.name) === familyKey(fontName))
        for (const variant of standardVariants) {
          let cached = fallbackFonts.get(variant)
          if (!cached) { cached = await getFont(native, native.context.obj({ BaseFont: name(variant), Encoding: name('WinAnsiEncoding') })); fallbackFonts.set(variant, cached) }
          candidates.push(cached)
        }
        for (const font of candidates) variants.push({ ...font, size: sourceFont?.size ?? 12, spacing: sourceFont?.spacing ?? 0, wordSpacing: sourceFont?.wordSpacing ?? 0 })
        const decoration = roots.find(root => decorationMatches(root.stream, item))?.stream.dict
        const showIndex = match[0] ? runs.indexOf(match[0]) : renderedFonts.indexOf(item.fontName)
        const originalFormat: TextFormat = { bold, italic, underline: decoration?.lookup(name('FolioUnderline'))?.toString() === 'true', strike: decoration?.lookup(name('FolioStrike'))?.toString() === 'true', fontSize: Math.hypot(item.transform[2], item.transform[3]), color: shownColors[showIndex] ?? '#000000' }
        blocks.push({ id: `${index}:text:${blocks.length}`, text: item.str, item, font: fontName, runs: match.map(run => run.id), editable: true, native: nativeEdit, sourceFont, fallbackFont, variants, originalFormat })
      }
      const viewport = page.getViewport({ scale: 1 })
      pages.push({ blocks, roots, runs, width: viewport.width, height: viewport.height, rotation: page.rotate, viewportTransform: viewport.transform, ascents: Object.fromEntries(Object.entries(content.styles).map(([key, style]) => [key, style.ascent ?? 0.8])), descents: Object.fromEntries(Object.entries(content.styles).map(([key, style]) => [key, style.descent ?? -0.2])) })
    }
    return { bytes, proxy, pages }
  } catch (error) { await proxy.loadingTask.destroy(); throw error }
}

function glyphWidth(font: FontInfo, code: string, char: string): number {
  const cached = font.widths.get(code)
  if (cached !== undefined) return cached
  if (font.standard) return font.standard.widthOfTextAtSize(char, 1000)
  const dict = font.dict
  if (!dict) throw new Error('Original font metrics are unavailable.')
  const cid = parseInt(code, 16)
  const descendants = dict.lookup(name('DescendantFonts'))
  if (descendants instanceof PDFArray) {
    const descendant = descendants.lookup(0, PDFDict)
    const widths = descendant.lookup(name('W'))
    if (widths instanceof PDFArray) {
      for (let i = 0; i < widths.size();) {
        const first = (widths.lookup(i++) as PDFNumber).asNumber()
        const next = widths.lookup(i++)
        if (next instanceof PDFArray) { if (cid >= first && cid < first + next.size()) return next.lookup(cid - first, PDFNumber).asNumber() }
        else if (next instanceof PDFNumber) { const width = widths.lookup(i++, PDFNumber).asNumber(); if (cid >= first && cid <= next.asNumber()) return width }
      }
    }
    const defaultWidth = descendant.lookup(name('DW'))
    return defaultWidth instanceof PDFNumber ? defaultWidth.asNumber() : 1000
  }
  const first = dict.lookup(name('FirstChar')), widths = dict.lookup(name('Widths'))
  if (first instanceof PDFNumber && widths instanceof PDFArray && cid >= first.asNumber() && cid < first.asNumber() + widths.size()) return widths.lookup(cid - first.asNumber(), PDFNumber).asNumber()
  throw new Error('Original font metrics are unavailable for this character.')
}

function encode(text: string, font: FontInfo): { code: string; advance: number; visibleAdvance: number } {
  let code = '', advance = 0, trailingSpacing = 0, offset = 0
  const choices = [...font.codes.keys()].sort((a, b) => b.length - a.length)
  while (offset < text.length) {
    const char = choices.find(value => value.length && text.startsWith(value, offset))
    if (!char) throw new Error(`“${String.fromCodePoint(text.codePointAt(offset)!)}” is not available in this PDF’s embedded font. Use a character already included in the font.`)
    const encoded = font.codes.get(char)!
    code += encoded
    const width = glyphWidth(font, encoded, char)
    const characterSpacing = font.spacing + (encoded === '20' ? font.wordSpacing : 0)
    trailingSpacing = characterSpacing
    advance += width + 1000 * characterSpacing / font.size
    offset += char.length
  }
  // The text cursor advances by Tc/Tw after the last glyph too, while the
  // visible text width (and PDF.js selection bounds) exclude that final gap.
  return { code, advance, visibleAdvance: advance - 1000 * trailingSpacing / font.size }
}

export type TextGeometry = { left: number; top: number; width: number; height: number; fontSize: number; horizontalSize: number; baseline: [number, number]; right: [number, number]; down: [number, number] }
export type TextLayout = { scale: number; width: number; availableWidth: number; fontSize: number; geometry: TextGeometry; slot: TextGeometry; fitted: boolean }

export function textGeometry(page: PageModel, block: TextBlock, scale = 1, width = block.item.width): TextGeometry {
  const matrix = pdfjs.Util.transform(page.viewportTransform, block.item.transform)
  const horizontalSize = Math.hypot(matrix[0], matrix[1])
  const fontSize = Math.hypot(matrix[2], matrix[3])
  const right: [number, number] = horizontalSize ? [matrix[0] / horizontalSize, matrix[1] / horizontalSize] : [1, 0]
  const down: [number, number] = fontSize ? [-matrix[2] / fontSize, -matrix[3] / fontSize] : [0, 1]
  const ascent = page.ascents[block.item.fontName] ?? 0.8
  const descent = page.descents[block.item.fontName] ?? -0.2
  return {
    left: matrix[4] - down[0] * fontSize * ascent * scale,
    top: matrix[5] - down[1] * fontSize * ascent * scale,
    width, height: fontSize * (ascent - descent) * scale, fontSize: fontSize * scale,
    horizontalSize: horizontalSize * scale, baseline: [matrix[4], matrix[5]], right, down,
  }
}

function projectPoint(geometry: TextGeometry, x: number, y: number): [number, number] {
  const [a, b] = geometry.right, [c, d] = geometry.down
  const determinant = a * d - b * c
  if (Math.abs(determinant) < 0.000001) throw new Error('This text has a degenerate transform.')
  const dx = x - geometry.baseline[0], dy = y - geometry.baseline[1]
  return [(d * dx - c * dy) / determinant, (-b * dx + a * dy) / determinant]
}

function corners(geometry: TextGeometry): [number, number][] {
  return [[0, 0], [geometry.width, 0], [0, geometry.height], [geometry.width, geometry.height]].map(([x, y]) => [geometry.left + geometry.right[0] * x + geometry.down[0] * y, geometry.top + geometry.right[1] * x + geometry.down[1] * y])
}

// Reserve both the original selection and any larger formatted glyph bounds.
// Resolve the neighbor against original bounds once, avoiding recursive layout.
function occupiedCorners(page: PageModel, block: TextBlock, boxes: TextBoxes, formats: TextFormats, edits: Edits): [number, number][] {
  const points = corners(textBoxGeometry(page, block, boxes[block.id]))
  if ((formats[block.id]?.fontSize ?? 0) > textGeometry(page, block).fontSize) {
    try { points.push(...corners(layoutText(page, block, edits[block.id] ?? block.text, boxes[block.id], boxes, formats[block.id]).geometry)) } catch { /* Original bounds remain reserved. */ }
  }
  return points
}

export function resizeTextBox(page: PageModel, block: TextBlock, requested: TextBoxSize, boxes: TextBoxes = {}, formats: TextFormats = {}, edits: Edits = {}): TextBoxSize {
  const geometry = textGeometry(page, block)
  const origin = { ...geometry, baseline: [geometry.left, geometry.top] as [number, number] }
  let width = Math.max(8, Number.isFinite(requested.width) ? requested.width : geometry.width)
  let height = Math.max(geometry.height, Number.isFinite(requested.height) ? requested.height : geometry.height)
  // The anchored top-left corner and both local axes work on rotated pages too.
  function limit(axis: [number, number], points: [number, number][]): number {
    let maximum = Infinity
    for (const point of points) for (let i = 0; i < 2; i++) {
      const boundary = i === 0 ? page.width : page.height
      if (axis[i] > 0.000001) maximum = Math.min(maximum, (boundary - point[i]) / axis[i])
      if (axis[i] < -0.000001) maximum = Math.min(maximum, -point[i] / axis[i])
    }
    return Math.max(0, maximum)
  }
  height = Math.min(height, limit(geometry.down, [[geometry.left, geometry.top]]))
  width = Math.min(width, limit(geometry.right, [[geometry.left, geometry.top], [geometry.left + geometry.down[0] * height, geometry.top + geometry.down[1] * height]]))
  height = Math.min(height, limit(geometry.down, [[geometry.left, geometry.top], [geometry.left + geometry.right[0] * width, geometry.top + geometry.right[1] * width]]))
  for (const neighbor of page.blocks) {
    if (neighbor.id === block.id) continue
    const points = occupiedCorners(page, neighbor, boxes, formats, edits).map(([x, y]) => projectPoint(origin, x, y))
    const left = Math.min(...points.map(point => point[0])), right = Math.max(...points.map(point => point[0]))
    const top = Math.min(...points.map(point => point[1])), bottom = Math.max(...points.map(point => point[1]))
    if (top >= geometry.height - 0.1 && left < width - 0.1 && right > 0.1) height = Math.min(height, Math.max(geometry.height, top - 0.75))
    if (left > 0.1 && top < height - 0.1 && bottom > 0.1) width = Math.min(width, Math.max(0, left - 0.75))
  }
  return { width, height }
}

export function textBoxGeometry(page: PageModel, block: TextBlock, box?: TextBoxSize, boxes: TextBoxes = {}): TextGeometry {
  const original = textGeometry(page, block)
  if (!box) return original
  return { ...original, ...resizeTextBox(page, block, box, boxes) }
}

function textSlot(page: PageModel, block: TextBlock, box?: TextBoxSize, boxes: TextBoxes = {}, formats: TextFormats = {}, edits: Edits = {}): { width: number; height: number; scale: number } {
  const geometry = textGeometry(page, block)
  if (box) {
    const resized = resizeTextBox(page, block, box, boxes, formats, edits)
    return { ...resized, scale: 1 }
  }
  let width = Math.max(0, block.item.width)
  // Keep replacements inside their original line, column and visible CropBox.
  for (const neighbor of page.blocks) {
    if (neighbor.id === block.id) continue
    const projected = occupiedCorners(page, neighbor, boxes, formats, edits).map(([x, y]) => projectPoint(geometry, x, y))
    const left = Math.min(...projected.map(point => point[0]))
    const top = Math.min(...projected.map(point => point[1])), bottom = Math.max(...projected.map(point => point[1]))
    const own = corners(geometry).map(([x, y]) => projectPoint(geometry, x, y))
    const ownTop = Math.min(...own.map(point => point[1])), ownBottom = Math.max(...own.map(point => point[1]))
    if (left > 0.1 && top < ownBottom - 0.1 && bottom > ownTop + 0.1) width = Math.min(width, Math.max(0, left - 0.75))
  }
  let scale = 1
  // A convex page contains the entire text rectangle when all four corners fit.
  // Only glyph height and width shrink; the baseline stays anchored.
  for (const [x, y] of corners({ ...geometry, width })) {
    for (const [origin, delta, boundary] of [[geometry.baseline[0], x - geometry.baseline[0], page.width], [geometry.baseline[1], y - geometry.baseline[1], page.height]]) {
      if (origin < -0.01 || origin > boundary + 0.01) throw new Error('This text starts outside the visible page and cannot be safely aligned.')
      if (delta > 0) scale = Math.min(scale, (boundary - origin) / delta)
      else if (delta < 0) scale = Math.min(scale, -origin / delta)
    }
  }
  return { width: width * Math.max(0, scale), height: geometry.height, scale: Math.max(0, scale) }
}

function keepsOriginalGlyphs(block: TextBlock, text: string, box: TextBoxSize | undefined, format: TextFormat): boolean {
  return text === block.text && !box && (['bold', 'italic', 'fontSize', 'color'] as const).every(key => format[key] === undefined || format[key] === block.originalFormat[key])
}

export function layoutText(page: PageModel, block: TextBlock, text: string, box?: TextBoxSize, boxes: TextBoxes = {}, format: TextFormat = {}, formats: TextFormats = {}, edits: Edits = {}): TextLayout {
  if (format.fontSize !== undefined && (!Number.isFinite(format.fontSize) || format.fontSize < 1 || format.fontSize > 300)) throw new Error('Choose a font size between 1 and 300 pt.')
  if (keepsOriginalGlyphs(block, text, box, format)) {
    const geometry = textGeometry(page, block)
    return { scale: 1, width: geometry.width, availableWidth: geometry.width, fontSize: geometry.fontSize, geometry, slot: geometry, fitted: false }
  }
  const font = editFont(block, text, format)
  const original = textGeometry(page, block)
  const encoded = encode(text, font)
  const slot = textSlot(page, block, box, boxes, formats, edits)
  const measuredWidth = Math.max(0, encoded.visibleAdvance * original.horizontalSize / 1000)
  // Scale glyphs and tracking together. Tf alone does not scale Tc/Tw, so the
  // exporter also temporarily adjusts those text-state parameters when fitting.
  const requestedScale = format.fontSize === undefined ? 1 : format.fontSize / original.fontSize
  if (!Number.isFinite(requestedScale) || requestedScale <= 0 || (format.fontSize !== undefined && (format.fontSize < 1 || format.fontSize > 300))) throw new Error('Choose a font size between 1 and 300 pt.')
  let scale = Math.min(format.fontSize === undefined ? slot.scale : requestedScale, measuredWidth > 0 ? slot.width / measuredWidth : requestedScale)
  // Font size changes keep the baseline anchored and cannot cross the page or
  // the previous/next line. Width still respects the user's resized box.
  for (const [x, y] of corners(textGeometry(page, block, 1, measuredWidth))) for (const [origin, delta, boundary] of [[original.baseline[0], x - original.baseline[0], page.width], [original.baseline[1], y - original.baseline[1], page.height]]) {
    if (delta > 0) scale = Math.min(scale, (boundary - origin) / delta)
    if (delta < 0) scale = Math.min(scale, -origin / delta)
  }
  if (scale > 1) {
    const own = corners(original).map(([x, y]) => projectPoint(original, x, y))
    const ownTop = Math.min(...own.map(p => p[1])), ownBottom = Math.max(...own.map(p => p[1]))
    for (const neighbor of page.blocks) {
      if (neighbor.id === block.id) continue
      const points = occupiedCorners(page, neighbor, boxes, formats, edits).map(([x, y]) => projectPoint(original, x, y))
      const left = Math.min(...points.map(p => p[0])), right = Math.max(...points.map(p => p[0]))
      if (right <= 0 || left >= measuredWidth * scale) continue
      const top = Math.min(...points.map(p => p[1])), bottom = Math.max(...points.map(p => p[1]))
      const originalPoints = corners(textGeometry(page, neighbor)).map(([x, y]) => projectPoint(original, x, y))
      if (Math.max(...originalPoints.map(p => p[1])) <= ownTop + 0.1 && ownTop < 0) scale = Math.min(scale, (bottom + 0.75) / ownTop)
      if (Math.min(...originalPoints.map(p => p[1])) >= ownBottom - 0.1 && ownBottom > 0) scale = Math.min(scale, (top - 0.75) / ownBottom)
    }
  }
  if (!Number.isFinite(scale) || scale <= 0 || (text.length > 0 && original.fontSize * scale < 1)) throw new Error('This text is too long to fit safely in this line. Please shorten it.')
  // Round down so the emitted PDF font size can never round outside its slot.
  const nativeSize = scale === 1 ? font.size : Math.floor(font.size * scale * 1e6) / 1e6
  scale = nativeSize / font.size
  const width = measuredWidth * scale
  const selectionScale = Math.max(1, scale)
  return { scale, width, availableWidth: slot.width, fontSize: original.fontSize * scale, geometry: textGeometry(page, block, scale, width), slot: { ...textGeometry(page, block, selectionScale, slot.width), height: Math.max(slot.height, original.height * selectionScale) }, fitted: scale < requestedScale - 0.0001 }
}

export function hitTestText(page: PageModel, edits: Edits, x: number, y: number, tolerance = 3, boxes: TextBoxes = {}, formats: TextFormats = {}): TextBlock | undefined {
  let nearest: TextBlock | undefined, distance = Infinity
  for (const block of page.blocks) {
    let geometry = textBoxGeometry(page, block, boxes[block.id], boxes)
    if ((edits[block.id] !== undefined && edits[block.id] !== '') || formats[block.id]) {
      try { const layout = layoutText(page, block, edits[block.id] ?? block.text, boxes[block.id], boxes, formats[block.id], formats, edits); geometry = boxes[block.id] ? layout.slot : layout.geometry } catch { /* Keep the original hit region for an invalid draft. */ }
    }
    const [horizontal, vertical] = projectPoint({ ...geometry, baseline: [geometry.left, geometry.top] }, x, y)
    const dx = Math.max(0, -horizontal, horizontal - geometry.width), dy = Math.max(0, -vertical, vertical - geometry.height)
    if (dx > tolerance || dy > tolerance) continue
    const score = Math.hypot(dx, dy) * 100 + Math.abs(vertical - geometry.height / 2)
    if (score < distance) { distance = score; nearest = block }
  }
  return nearest
}

export function validateEdit(document: EditorDocument, block: TextBlock, text: string, box?: TextBoxSize, boxes: TextBoxes = {}, format: TextFormat = {}, formats: TextFormats = {}, edits: Edits = {}): string | null {
  if (/[\r\n]/.test(text)) return 'Edit one text line at a time.'
  const page = document.pages.find(candidate => candidate.blocks.some(value => value.id === block.id))
  if (!page) return 'Original text could not be found.'
  if (format.color !== undefined && !/^#[\da-f]{6}$/i.test(format.color)) return 'Choose a valid text colour.'
  try { layoutText(page, block, text, box, boxes, format, formats, edits); return null } catch (error) { return error instanceof Error ? error.message : 'This text cannot be encoded in the original font.' }
}

// A font/stream mismatch is an export strategy, never an editing restriction.
// Reuse the native encoding whenever possible; preserve weight/style in a
// compatible font when the original subset cannot encode the replacement.
function editFont(block: TextBlock, text: string, format: TextFormat = {}): FontInfo {
  const bold = format.bold ?? block.originalFormat.bold ?? weight(block.font)
  const italic = format.italic ?? block.originalFormat.italic ?? slant(block.font)
  const originalStyle = bold === block.originalFormat.bold && italic === block.originalFormat.italic
  if (originalStyle && block.sourceFont?.dict && block.sourceFont.size > 0 && block.sourceFont.dict.lookup(name('Subtype'))?.toString() !== '/Type3') {
    try { encode(text, block.sourceFont); return block.sourceFont } catch { /* Use the compatible font. */ }
  }
  if (!originalStyle) for (const variant of block.variants) {
    if (weight(variant.name) !== bold || slant(variant.name) !== italic) continue
    try { encode(text, variant); return variant } catch { /* Try the next compatible font. */ }
  }
  encode(text, block.fallbackFont); return block.fallbackFont
}

export function fontForEdit(block: TextBlock, text: string, format: TextFormat = {}): { name: string; substituted: boolean } {
  const font = editFont(block, text, format)
  return { name: font.name, substituted: font !== block.sourceFont && familyKey(font.name) !== familyKey(block.font) }
}

function nativeEdit(block: TextBlock, text: string): boolean {
  return block.native && (!!block.sourceFont?.dict || !!editFont(block, text).standard)
}

function decorationMatches(stream: PDFRawStream, item: TextItem): boolean {
  const x = stream.dict.lookup(name('FolioX')), y = stream.dict.lookup(name('FolioY'))
  return x instanceof PDFNumber && y instanceof PDFNumber && Math.abs(x.asNumber() - item.transform[4]) < 0.01 && Math.abs(y.asNumber() - item.transform[5]) < 0.01
}

function addDecorations(native: PDFDocument, index: number, model: PageModel, edits: Edits, boxes: TextBoxes, formats: TextFormats, all = false) {
  for (const block of model.blocks) {
    if (!all && edits[block.id] === undefined && !boxes[block.id] && !formats[block.id]) continue
    const style = { ...block.originalFormat, ...formats[block.id] }
    const text = edits[block.id] ?? block.text
    if (!text || (!style.underline && !style.strike)) continue
    const layout = layoutText(model, block, text, boxes[block.id], boxes, formats[block.id], formats, edits)
    const matrix = block.item.transform, horizontal = Math.hypot(matrix[0], matrix[1]), vertical = Math.hypot(matrix[2], matrix[3])
    const output: string[] = []
    for (const offset of [style.underline ? 0.13 : null, style.strike ? -0.3 : null]) {
      if (offset === null) continue
      const x = matrix[4] - matrix[2] / vertical * layout.fontSize * offset, y = matrix[5] - matrix[3] / vertical * layout.fontSize * offset
      output.push(`q ${colourCommand(style.color ?? '#000000')} RG ${Math.max(0.4, layout.fontSize / 18).toFixed(4)} w ${x.toFixed(6)} ${y.toFixed(6)} m ${(x + matrix[0] / horizontal * layout.width).toFixed(6)} ${(y + matrix[1] / horizontal * layout.width).toFixed(6)} l S Q`)
    }
    const stream = native.context.flateStream(output.join('\n'), { FolioX: matrix[4], FolioY: matrix[5], FolioUnderline: !!style.underline, FolioStrike: !!style.strike })
    native.getPage(index).node.addContentStream(native.context.register(stream))
  }
}

// Rare streams that cannot be linked to whole native operations are rebuilt
// visually. Recovered text remains searchable and editable as real vector text,
// and the old text is removed instead of being hidden underneath a white box.
async function rebuildPage(document: EditorDocument, native: PDFDocument, index: number, edits: Edits, boxes: TextBoxes, formats: TextFormats): Promise<void> {
  const model = document.pages[index]
  let cleanDocument: pdfjs.PDFDocumentProxy | undefined
  const canvas = window.document.createElement('canvas'), background = window.document.createElement('canvas')
  try {
    if (model.roots.some(root => root.stream.dict.has(name('FolioX')))) {
      const copy = await PDFDocument.load(document.bytes)
      const page = copy.getPage(index), contents = page.node.Contents()
      if (contents instanceof PDFArray) page.node.set(name('Contents'), copy.context.obj(contents.asArray().filter(value => {
        const stream = copy.context.lookup(value)
        return !(stream instanceof PDFRawStream && stream.dict.has(name('FolioX')))
      })))
      cleanDocument = await pdfjs.getDocument({ ...pdfOptions, data: new Uint8Array(await copy.save()) }).promise
    }
    const proxy = await (cleanDocument ?? document.proxy).getPage(index + 1)
    const base = proxy.getViewport({ scale: 1, rotation: 0 })
    const scale = Math.min(3, 8192 / Math.max(base.width, base.height), Math.sqrt(20_000_000 / (base.width * base.height)))
    const viewport = proxy.getViewport({ scale, rotation: 0 })
    canvas.width = background.width = Math.ceil(viewport.width)
    canvas.height = background.height = Math.ceil(viewport.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const clean = background.getContext('2d')!
    await proxy.render({ canvas, canvasContext: context, viewport }).promise
    // Rendering optimizes its operator list differently from getOperatorList().
    // Filter the list supplied to the callback, never indices from another list.
    await proxy.render({ canvas: background, canvasContext: clean, viewport, operationsFilter: (i, operators) => ![pdfjs.OPS.showText, pdfjs.OPS.showSpacedText, pdfjs.OPS.nextLineShowText, pdfjs.OPS.nextLineSetSpacingShowText].includes(operators.fnArray[i]) }).promise
    const colours = new Map<string, string>()
    const unrotated = { ...model, viewportTransform: base.transform }
    for (const block of model.blocks) {
      const text = edits[block.id] ?? block.text
      try { editFont(block, text, formats[block.id]) } catch { continue /* Retain unrecoverable original glyphs in the page image. */ }
      const geometry = textGeometry(unrotated, block)
      const bounds = corners({ ...geometry, left: geometry.left - geometry.right[0] * 0.35 - geometry.down[0] * 0.35, top: geometry.top - geometry.right[1] * 0.35 - geometry.down[1] * 0.35, width: geometry.width + 0.7, height: geometry.height + 0.7 })
      const polygon = [bounds[0], bounds[1], bounds[3], bounds[2]]
      const minX = Math.max(0, Math.floor(Math.min(...polygon.map(p => p[0])) * scale))
      const minY = Math.max(0, Math.floor(Math.min(...polygon.map(p => p[1])) * scale))
      const width = Math.min(canvas.width - minX, Math.ceil(Math.max(...polygon.map(p => p[0])) * scale) - minX)
      const height = Math.min(canvas.height - minY, Math.ceil(Math.max(...polygon.map(p => p[1])) * scale) - minY)
      // Compare against the text-free render so coloured text is recovered even
      // over a photograph, coloured table cell, watermark or ruled background.
      const counts = new Map<string, number>()
      if (width > 0 && height > 0) {
        const original = context.getImageData(minX, minY, width, height).data
        const cleared = clean.getImageData(minX, minY, width, height).data
        for (let i = 0; i < original.length; i += 4) {
          if (Math.abs(original[i] - cleared[i]) + Math.abs(original[i + 1] - cleared[i + 1]) + Math.abs(original[i + 2] - cleared[i + 2]) < 100) continue
          const colour = `${original[i]} ${original[i + 1]} ${original[i + 2]}`
          counts.set(colour, (counts.get(colour) ?? 0) + 1)
        }
      }
      colours.set(block.id, [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '0 0 0')
      context.save(); context.beginPath()
      polygon.forEach(([x, y], i) => { if (i) context.lineTo(x * scale, y * scale); else context.moveTo(x * scale, y * scale) })
      context.closePath(); context.clip(); context.drawImage(background, 0, 0); context.restore()
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not rebuild this PDF page.')), 'image/png'))
    const image = await native.embedPng(await blob.arrayBuffer())
    const page = native.getPage(index)
    page.node.set(name('Contents'), native.context.obj([]))
    page.drawImage(image, { x: proxy.view[0], y: proxy.view[1], width: base.width, height: base.height })
    const resources = page.node.Resources()!.clone(native.context)
    const oldFonts = resources.lookup(name('Font'))
    const fonts = oldFonts instanceof PDFDict ? oldFonts.clone(native.context) : native.context.obj({})
    resources.set(name('Font'), fonts)
    page.node.set(name('Resources'), resources)
    const aliases = new Map<FontInfo, PDFName>()
    const output: string[] = []
    for (const block of model.blocks) {
      const changed = (edits[block.id] !== undefined && edits[block.id] !== block.text) || !!boxes[block.id] || !!formats[block.id]
      const text = edits[block.id] ?? block.text
      if (!text) continue
      let font: FontInfo
      try { font = editFont(block, text, formats[block.id]) } catch { continue /* Unrepresentable original glyphs remain in the page image. */ }
      let alias = aliases.get(font)
      if (!alias) {
        alias = fonts.uniqueKey('FolioText')
        const ref = font.dict?.context.getObjectRef(font.dict) ?? (font.standard ? (await native.embedFont(font.name as StandardFonts)).ref : undefined)
        if (!ref) throw new Error('Could not recover this PDF font.')
        fonts.set(alias, ref); aliases.set(font, alias)
      }
      const encoded = encode(text, font)
      const layout = changed ? layoutText(model, block, text, boxes[block.id], boxes, formats[block.id], formats, edits) : null
      const fit = layout?.scale ?? 1
      const matrix = block.item.transform
      // Extracted items can span multiple TJ adjustments. Match their original
      // width when reconstructing unchanged lines, keeping their baseline exact.
      const measured = encoded.visibleAdvance * Math.hypot(matrix[0], matrix[1]) / 1000
      const horizontalFit = changed || measured <= 0 ? fit : block.item.width / measured
      const values = [matrix[0] * horizontalFit / font.size, matrix[1] * horizontalFit / font.size, matrix[2] * fit / font.size, matrix[3] * fit / font.size, matrix[4], matrix[5]]
      const colour = formats[block.id]?.color ? colourCommand(formats[block.id].color!) : (colours.get(block.id) ?? '0 0 0').split(' ').map(value => (Number(value) / 255).toFixed(6)).join(' ')
      output.push(`q ${values.map(value => value.toFixed(8)).join(' ')} cm ${colour} rg BT ${alias} ${font.size} Tf ${font.spacing} Tc ${font.wordSpacing} Tw 0 Tr 1 0 0 1 0 0 Tm <${encoded.code}> Tj ET Q`)
    }
    page.node.addContentStream(native.context.register(native.context.flateStream(output.join('\n'))))
  } finally {
    canvas.width = background.width = 0
    await cleanDocument?.loadingTask.destroy()
  }
}

export async function exportDocument(document: EditorDocument, edits: Edits, boxes: TextBoxes = {}, formats: TextFormats = {}): Promise<Uint8Array> {
  const native = await PDFDocument.load(document.bytes)
  for (let index = 0; index < document.pages.length; index++) {
    const model = document.pages[index]
    const changed = model.blocks.filter(block => (edits[block.id] !== undefined && edits[block.id] !== block.text) || !!boxes[block.id] || !!formats[block.id])
    for (const block of changed) {
      const error = validateEdit(document, block, edits[block.id] ?? block.text, boxes[block.id], boxes, formats[block.id], formats, edits)
      if (error) throw new Error(error)
    }
    if (changed.some(block => !nativeEdit(block, edits[block.id] ?? block.text))) {
      await rebuildPage(document, native, index, edits, boxes, formats)
      addDecorations(native, index, model, edits, boxes, formats, true)
      continue
    }
    const replacements = new Map<string, string>()
    const fittedFonts = new Map<string, PDFDict>()
    const nodes = new Map<string, StreamNode>()
    function rememberNode(node: StreamNode) { nodes.set(node.key, node); node.children.forEach(rememberNode) }
    model.roots.forEach(rememberNode)
    for (const block of model.blocks) {
      const text = edits[block.id] ?? block.text
      if (text === block.text && !boxes[block.id] && !formats[block.id]) continue
      if (keepsOriginalGlyphs(block, text, boxes[block.id], formats[block.id] ?? {})) continue
      const error = validateEdit(document, block, text, boxes[block.id], boxes, formats[block.id], formats, edits)
      if (error) throw new Error(error)
      const selected = block.runs.map(id => model.runs.find(run => run.id === id)!)
      const layout = layoutText(model, block, text, boxes[block.id], boxes, formats[block.id], formats, edits)
      const firstFont = editFont(block, text, formats[block.id])
      const fittedSize = selected[0].font.size * layout.scale
      const encoded = encode(text, { ...firstFont, size: fittedSize, spacing: firstFont.spacing * layout.scale, wordSpacing: firstFont.wordSpacing * layout.scale })
      let fittedResource = firstFont.resource
      let restoreResource = selected[0].font.resource
      if ((layout.scale !== 1 || firstFont !== block.sourceFont || !!formats[block.id]?.color) && firstFont.dict) {
        let fonts = fittedFonts.get(selected[0].node)
        if (!fonts) {
          const originalFonts = nodes.get(selected[0].node)!.resources.lookup(name('Font'))
          fonts = originalFonts instanceof PDFDict ? originalFonts.clone(native.context) : native.context.obj({})
          fittedFonts.set(selected[0].node, fonts)
        }
        // A form may inherit its active font from its caller. Give the fitted
        // run a local alias so Tf is valid even with a different form dictionary.
        const alias = fonts.uniqueKey('FolioFitFont')
        const originalRef = firstFont.dict.context.getObjectRef(firstFont.dict)
        fonts.set(alias, originalRef ?? (await native.embedFont(firstFont.name as StandardFonts)).ref)
        fittedResource = alias.toString()
        const restoreAlias = fonts.uniqueKey('FolioOriginalFont')
        const originalDict = selected[0].font.dict!
        fonts.set(restoreAlias, originalDict.context.getObjectRef(originalDict)!)
        restoreResource = restoreAlias.toString()
      }
      selected.forEach((run, i) => {
        const size = i === 0 ? fittedSize : run.font.size
        const advance = i === 0 ? encoded.advance : 0
        // TJ moves the text cursor in units of the active font size. Preserve its
        // original endpoint even when Tf changes, including following Td/Tj runs.
        const adjustment = (advance - run.advance * run.font.size / size).toFixed(6)
        let prefix = ''
        if (run.operation.command === "'") prefix = 'T* '
        if (run.operation.command === '"') prefix = `${run.operation.args[0].value} Tw ${run.operation.args[1].value} Tc T* `
        const styled = i === 0 && (layout.scale !== 1 || firstFont !== block.sourceFont || !!formats[block.id]?.color)
        const before = styled ? `${fittedResource} ${size.toFixed(6)} Tf ${(firstFont.spacing * layout.scale).toFixed(8)} Tc ${(firstFont.wordSpacing * layout.scale).toFixed(8)} Tw ${formats[block.id]?.color ? colourCommand(formats[block.id].color!) + ' rg ' : ''}` : ''
        // q/Q restores PDF.js text cursor state as well as typography. Restore
        // individual parameters instead, preserving the compensated endpoint.
        const after = styled ? ` ${restoreResource} ${run.font.size} Tf ${run.font.spacing} Tc ${run.font.wordSpacing} Tw ${formats[block.id]?.color ? colourCommand(block.originalFormat.color ?? '#000000') + ' rg' : ''}` : ''
        replacements.set(run.id, `${prefix}${before}[<${i === 0 ? encoded.code : ''}> ${adjustment}] TJ${after}`)
      })
    }
    if (!changed.length) continue
    // Clone resources and Form XObjects per invocation so shared forms/pages stay unchanged.
    function rewrite(node: StreamNode): PDFRawStream {
      const resources = node.resources.clone(native.context)
      const fonts = fittedFonts.get(node.key)
      if (fonts) resources.set(name('Font'), fonts)
      const originalObjects = resources.lookup(name('XObject'))
      const objects = originalObjects instanceof PDFDict ? originalObjects.clone(native.context) : undefined
      if (objects) resources.set(name('XObject'), objects)
      const changes: { start: number; end: number; text: string }[] = []
      node.operations.forEach((op, i) => {
        const replacement = replacements.get(`${node.key}:${i}`)
        if (replacement !== undefined) changes.push({ start: op.start, end: op.end, text: replacement })
        const child = node.children.get(i)
        if (child && objects) {
          const resourceName = objects.uniqueKey('EditedForm')
          objects.set(resourceName, native.context.register(rewrite(child)))
          changes.push({ start: op.start, end: op.end, text: `${resourceName.toString()} Do` })
        }
      })
      let source = node.source
      for (const change of changes.sort((a, b) => b.start - a.start)) source = source.slice(0, change.start) + change.text + source.slice(change.end)
      const dictionary = node.stream.dict.clone(native.context)
      dictionary.delete(name('Filter')); dictionary.delete(name('DecodeParms')); dictionary.delete(name('Length'))
      dictionary.set(name('Resources'), resources)
      return PDFRawStream.of(dictionary, Uint8Array.from(source, char => char.charCodeAt(0)))
    }
    const streams = model.roots.filter(root => !changed.some(block => decorationMatches(root.stream, block.item))).map(root => rewrite(root))
    // Page-level stream resource dictionaries are ignored by PDF viewers. Merge cloned resources.
    const pageResources = native.getPage(index).node.Resources()?.clone(native.context) ?? native.context.obj({})
    const oldObjects = pageResources.lookup(name('XObject'))
    const objects = oldObjects instanceof PDFDict ? oldObjects.clone(native.context) : native.context.obj({})
    const originalFonts = pageResources.lookup(name('Font'))
    const fonts = originalFonts instanceof PDFDict ? originalFonts.clone(native.context) : native.context.obj({})
    for (const stream of streams) {
      const streamResources = stream.dict.lookup(name('Resources'), PDFDict)
      const own = streamResources.lookup(name('XObject'))
      if (own instanceof PDFDict) own.entries().forEach(([key, value]) => objects.set(key, value))
      const ownFonts = streamResources.lookup(name('Font'))
      if (ownFonts instanceof PDFDict) ownFonts.entries().forEach(([key, value]) => fonts.set(key, value))
      stream.dict.delete(name('Resources'))
    }
    pageResources.set(name('XObject'), objects)
    pageResources.set(name('Font'), fonts)
    native.getPage(index).node.set(name('Resources'), pageResources)
    native.getPage(index).node.set(name('Contents'), native.context.obj(streams.map(stream => native.context.register(stream))))
    addDecorations(native, index, model, edits, boxes, formats)
  }
  return new Uint8Array(await native.save())
}

export async function createDemo(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const serif = await doc.embedFont(StandardFonts.TimesRoman)
  for (let number = 1; number <= 2; number++) {
    const page = doc.addPage([595, 842])
    page.drawRectangle({ x: 0, y: 724, width: 595, height: 118, color: rgb(0.94, 0.96, 1) })
    page.drawText(number === 1 ? 'Make it your own.' : 'Keep every detail.', { x: 54, y: 770, size: 30, font: bold, color: rgb(0.15, 0.22, 0.43) })
    page.drawText('A little document with a lot of possibility.', { x: 54, y: 743, size: 11, font: regular, color: rgb(0.35, 0.4, 0.5) })
    page.drawText(number === 1 ? 'Your next great idea starts here.' : 'This is the second page.', { x: 54, y: 663, size: 21, font: serif })
    page.drawText('Click any text to edit it directly.', { x: 54, y: 620, size: 13, font: regular })
    page.drawText('The original font, colour and layout stay with your document.', { x: 54, y: 596, size: 12, font: regular })
    page.drawText('PROJECT NOTES', { x: 54, y: 532, size: 10, font: bold, color: rgb(0.3, 0.38, 0.6) })
    page.drawText('A fresh start for your PDF.', { x: 54, y: 501, size: 15, font: bold })
    page.drawText('Select a line, change the words, and apply your edit.', { x: 54, y: 469, size: 12, font: regular })
    page.drawText('Download your PDF when you are happy with the result.', { x: 54, y: 446, size: 12, font: regular })
    page.drawText(`DOCUMENT STUDIO                                    ${number} / 2`, { x: 54, y: 45, size: 9, font: regular, color: rgb(0.5, 0.55, 0.65) })
  }
  return new Uint8Array(await doc.save())
}
