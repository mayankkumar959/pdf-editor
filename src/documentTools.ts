import { PDFDocument, StandardFonts, concatTransformationMatrix, popGraphicsState, pushGraphicsState, rgb } from 'pdf-lib'
import type { PDFFont } from 'pdf-lib'
import type { PageModel, TextFormat } from './pdfEngine'

type Bounds = { id: string; page: number; x: number; y: number; width: number; height: number }
export type AddedText = Bounds & { kind: 'text'; text: string; family: 'Helvetica' | 'Times' | 'Courier'; format: TextFormat }
export type AddedImage = Bounds & { kind: 'image' | 'signature'; data: string; label: string }
export type AddedObject = AddedText | AddedImage
export type MergeFile = { id: string; name: string; bytes?: Uint8Array; pages: number }

export function sameObject(a: AddedObject, b: AddedObject | undefined): boolean {
  if (!b || a.id !== b.id || a.kind !== b.kind || a.page !== b.page || a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height) return false
  return a.kind === 'text' && b.kind === 'text' ? a.text === b.text && a.family === b.family && JSON.stringify(a.format) === JSON.stringify(b.format) : a.kind !== 'text' && b.kind !== 'text' && a.data === b.data && a.label === b.label
}

const metrics = new Map<string, PDFFont>()
let preparing: Promise<void> | undefined
export function prepareObjectFonts(): Promise<void> {
  return preparing ??= (async () => {
    const doc = await PDFDocument.create()
    for (const name of Object.values(StandardFonts)) if (name !== StandardFonts.Symbol && name !== StandardFonts.ZapfDingbats) metrics.set(name, await doc.embedFont(name))
  })()
}
export function objectFontName(object: AddedText): StandardFonts {
  const { bold, italic } = object.format
  if (object.family === 'Times') return bold ? italic ? StandardFonts.TimesRomanBoldItalic : StandardFonts.TimesRomanBold : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman
  if (object.family === 'Courier') return bold ? italic ? StandardFonts.CourierBoldOblique : StandardFonts.CourierBold : italic ? StandardFonts.CourierOblique : StandardFonts.Courier
  return bold ? italic ? StandardFonts.HelveticaBoldOblique : StandardFonts.HelveticaBold : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica
}
export function layoutAddedText(object: AddedText): { lines: { text: string; width: number; baseline: number }[]; height: number } {
  const font = metrics.get(objectFontName(object))
  if (!font) throw new Error('Text fonts are still loading. Please try again.')
  const size = object.format.fontSize ?? 16
  if (!Number.isFinite(size) || size < 1 || size > 300) throw new Error('Choose a font size between 1 and 300 pt.')
  const maxWidth = object.width - 10
  const measure = (text: string) => [...text].reduce((width, char) => width + font.widthOfTextAtSize(char, size), 0)
  const strings: string[] = []
  for (const paragraph of object.text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')) {
    let line = ''
    for (const word of paragraph.match(/\S+\s*|\s+/g) ?? []) {
      if (line && measure(line + word) > maxWidth) { strings.push(line.trimEnd()); line = '' }
      for (const char of word) {
        if (measure(char) > maxWidth) throw new Error('Widen this text box or reduce the font size.')
        if (line && measure(line + char) > maxWidth) { strings.push(line.trimEnd()); line = '' }
        line += char
      }
    }
    strings.push(line.trimEnd())
  }
  const lines = strings.map((text, index) => ({ text, width: measure(text), baseline: 5 + size + index * size * 1.25 }))
  return { lines, height: 10 + Math.max(1, lines.length) * size * 1.25 }
}
export function constrainObject(object: AddedObject, page: Pick<PageModel, 'width' | 'height'>): AddedObject {
  let width = Math.max(object.kind === 'text' ? Math.min(24, page.width) : .1, Number.isFinite(object.width) ? object.width : 200)
  let height = Math.max(object.kind === 'text' ? Math.min(20, page.height) : .1, Number.isFinite(object.height) ? object.height : 60)
  if (object.kind !== 'text') { const fit = Math.min(1, page.width / width, page.height / height); width *= fit; height *= fit }
  else { width = Math.min(page.width, width); height = Math.min(page.height, height) }
  if (object.kind === 'text') {
    try { height = Math.min(page.height, Math.max(height, layoutAddedText({ ...object, width }).height)) } catch { /* Show validation beside the editable content. */ }
  }
  return { ...object, width, height, x: Math.max(0, Math.min(page.width - width, Number.isFinite(object.x) ? object.x : 0)), y: Math.max(0, Math.min(page.height - height, Number.isFinite(object.y) ? object.y : 0)) }
}
export function validateObject(object: AddedObject, pages: PageModel[]): string | null {
  const page = pages[object.page]
  if (!page) return 'This object refers to a missing page.'
  if (![object.x, object.y, object.width, object.height].every(Number.isFinite) || object.width <= 0 || object.height <= 0 || object.x < 0 || object.y < 0 || object.x + object.width > page.width + .01 || object.y + object.height > page.height + .01) return 'Keep this object inside the page.'
  if (object.kind === 'text') {
    try {
      if (!/^#[\da-f]{6}$/i.test(object.format.color ?? '#000000')) return 'Choose a valid text colour.'
      if (layoutAddedText(object).height > object.height + .01) return 'The text is too tall for this page. Shorten it or reduce the font size.'
    } catch (error) { return error instanceof Error ? error.message : 'This text cannot be added.' }
  }
  return null
}
const colour = (hex: string) => rgb(...[1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number])

export async function addObjects(bytes: Uint8Array, pages: PageModel[], objects: AddedObject[]): Promise<Uint8Array> {
  if (!objects.length) return bytes
  await prepareObjectFonts()
  const doc = await PDFDocument.load(bytes)
  const fonts = new Map<string, PDFFont>()
  const images = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>()
  for (const object of objects) {
    const error = validateObject(object, pages)
    if (error) throw new Error(error)
    const page = doc.getPage(object.page)
    const [a, b, c, d, e, f] = pages[object.page].viewportTransform
    const determinant = a * d - b * c
    // Map screen coordinates to PDF coordinates, including CropBox and rotation.
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(d / determinant, -b / determinant, c / determinant, -a / determinant, (c * f - d * e) / determinant, (b * e - a * f) / determinant))
    if (object.kind === 'text') {
      const name = objectFontName(object)
      let font = fonts.get(name)
      if (!font) { font = await doc.embedFont(name); fonts.set(name, font) }
      const size = object.format.fontSize ?? 16, ink = colour(object.format.color ?? '#000000')
      for (const line of layoutAddedText(object).lines) {
        const x = object.x + 5, y = -(object.y + line.baseline)
        page.drawText(line.text, { x, y, size, font, color: ink })
        for (const offset of [object.format.underline ? -.13 : null, object.format.strike ? .3 : null]) if (offset !== null && line.width) page.drawLine({ start: { x, y: y + size * offset }, end: { x: x + line.width, y: y + size * offset }, thickness: Math.max(.4, size / 18), color: ink })
      }
    } else {
      let image = images.get(object.data)
      if (!image) { image = await doc.embedPng(object.data); images.set(object.data, image) }
      page.drawImage(image, { x: object.x, y: -object.y - object.height, width: object.width, height: object.height })
    }
    page.pushOperators(popGraphicsState())
  }
  return new Uint8Array(await doc.save())
}

export async function imageFile(file: File): Promise<{ data: string; width: number; height: number }> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) throw new Error('Choose a PNG, JPEG or WebP image.')
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  try {
    const ratio = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height))
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return { data: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }
  } finally { bitmap.close(); canvas.width = canvas.height = 0 }
}

export async function inspectMergeFile(file: File): Promise<MergeFile> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const doc = await PDFDocument.load(bytes)
  if (!doc.getPageCount()) throw new Error(`${file.name} has no pages.`)
  return { id: crypto.randomUUID(), name: file.name, bytes, pages: doc.getPageCount() }
}
export async function mergeDocuments(files: Uint8Array[]): Promise<Uint8Array> {
  if (files.length < 2) throw new Error('Choose at least two PDFs to merge.')
  const output = await PDFDocument.create()
  for (const bytes of files) {
    const source = await PDFDocument.load(bytes)
    for (const page of await output.copyPages(source, source.getPageIndices())) output.addPage(page)
  }
  return new Uint8Array(await output.save())
}
export function parsePages(input: string, count: number): number[] {
  if (!input.trim()) throw new Error('Enter page numbers, for example 1-3, 5.')
  const pages: number[] = []
  for (const token of input.split(',')) {
    const match = token.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/)
    if (!match) throw new Error('Use page numbers and ranges, for example 1-3, 5.')
    const first = Number(match[1]), last = Number(match[2] ?? match[1])
    if (first < 1 || last > count || first > last) throw new Error(`Page ranges must be between 1 and ${count}, in ascending order.`)
    for (let page = first; page <= last; page++) if (!pages.includes(page - 1)) pages.push(page - 1)
  }
  return pages
}
export async function extractPages(bytes: Uint8Array, indices: number[]): Promise<Uint8Array> {
  return (await splitDocuments(bytes, [indices]))[0]
}
export async function splitDocuments(bytes: Uint8Array, groups: number[][]): Promise<Uint8Array[]> {
  const source = await PDFDocument.load(bytes), results: Uint8Array[] = []
  for (const indices of groups) {
    if (!indices.length || indices.some(index => !Number.isInteger(index) || index < 0 || index >= source.getPageCount())) throw new Error('Choose valid pages to extract.')
    const output = await PDFDocument.create()
    for (const page of await output.copyPages(source, indices)) output.addPage(page)
    results.push(new Uint8Array(await output.save()))
  }
  return results
}

// Stored ZIP entries keep splitting entirely local without a server or dependency.
export function zipFiles(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  if (files.length > 65535 || files.reduce((sum, file) => sum + file.bytes.length + 1024, 22) > 0xffffffff) throw new Error('This ZIP is too large. Split fewer pages at a time.')
  const encoder = new TextEncoder(), entries: Uint8Array[] = [], central: Uint8Array[] = []
  let offset = 0
  for (const file of files) {
    const name = encoder.encode(file.name)
    let crc = 0xffffffff
    for (const byte of file.bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
    crc = (crc ^ 0xffffffff) >>> 0
    const header = new Uint8Array(30 + name.length), view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x800, true); view.setUint16(12, 33, true)
    view.setUint32(14, crc, true); view.setUint32(18, file.bytes.length, true); view.setUint32(22, file.bytes.length, true); view.setUint16(26, name.length, true); header.set(name, 30)
    const directory = new Uint8Array(46 + name.length), dv = new DataView(directory.buffer)
    dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true); dv.setUint16(8, 0x800, true); dv.setUint16(14, 33, true)
    dv.setUint32(16, crc, true); dv.setUint32(20, file.bytes.length, true); dv.setUint32(24, file.bytes.length, true); dv.setUint16(28, name.length, true); dv.setUint32(42, offset, true); directory.set(name, 46)
    entries.push(header, file.bytes); central.push(directory); offset += header.length + file.bytes.length
  }
  const size = central.reduce((sum, entry) => sum + entry.length, 0), end = new Uint8Array(22), view = new DataView(end.buffer)
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.length, true); view.setUint16(10, files.length, true); view.setUint32(12, size, true); view.setUint32(16, offset, true)
  const result = new Uint8Array(offset + size + end.length)
  let position = 0
  for (const chunk of [...entries, ...central, end]) { result.set(chunk, position); position += chunk.length }
  return result
}
export function saveFile(bytes: Uint8Array, filename: string, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }))
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
