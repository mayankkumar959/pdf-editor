import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Ref, RefObject } from 'react'
import { createPortal } from 'react-dom'
import * as pdfjs from 'pdfjs-dist'
import { exportFlowDocument, flowFont, pdfOptions, textFreeDocument, textGeometry } from './pdfEngine'
import type { EditorDocument, FlowOutputPage, FlowPlacement, PageModel, TextBlock, TextFormat } from './pdfEngine'
import { ObjectLayer } from './ObjectTools'
import type { AddedObject } from './documentTools'

export type FlowStatus = { dirty: boolean; canUndo: boolean; canRedo: boolean; pages: number; substituted: boolean; pageSources: number[] }
export type FlowEditorHandle = {
  export: () => Promise<{ bytes: Uint8Array; pages: PageModel[]; sourcePages: number[] }>
  undo: () => void
  redo: () => void
  format: (patch: TextFormat) => void
  scrollToPage: (index: number) => void
  scrollToSheet: (index: number) => void
  pageElement: (index: number) => HTMLDivElement | undefined
}
type Row = { blocks: TextBlock[]; x: number; top: number; bottom: number; right: number; size: number }
type Lane = { x: number; top: number; width: number; bottom: number; rows: Row[]; footer?: boolean }
type Sheet = { source: number; continuation: boolean; element: HTMLDivElement; columns: HTMLDivElement[]; objectTarget: HTMLDivElement }
type Section = { source: number; lanes: Lane[]; sheets: Sheet[] }
type Snapshot = string[][]
type Props = { document: EditorDocument; zoom: number; editable: boolean; objects: AddedObject[]; selected: AddedObject | null; ref?: Ref<FlowEditorHandle>; onStatus: (status: FlowStatus) => void; onFormat: (format: TextFormat) => void; onError: (message: string) => void; onFocusText: (source: number, index: number) => void; onSelectObject: (object: AddedObject) => boolean; onChangeObject: (object: AddedObject) => void; onCommitObject: (object: AddedObject) => void }

export function FlowThumbnail({ editor, index, width, revision, objects }: { editor: RefObject<FlowEditorHandle | null>; index: number; width: number; revision: FlowStatus; objects: AddedObject[] }) {
  const target = useRef<HTMLDivElement>(null)
  const preview = useRef<ShadowRoot | null>(null)
  useEffect(() => {
    // Update after a typing pause. Thumbnail work must not interrupt the caret.
    const timer = window.setTimeout(() => {
      const original = editor.current?.pageElement(index)
      if (!original || !target.current) return
      const copy = original.cloneNode(true) as HTMLDivElement
      copy.inert = true
      copy.style.zoom = String(108 / width); copy.style.boxShadow = 'none'
      copy.querySelectorAll<HTMLElement>('[contenteditable]').forEach(node => { node.contentEditable = 'false' })
      copy.querySelectorAll<HTMLElement>('[tabindex], button, textarea').forEach(node => { node.tabIndex = -1 })
      copy.querySelectorAll('.object-tag,.object-resize,[data-flow-bookmark]').forEach(node => node.remove())
      copy.querySelectorAll('.object-selected').forEach(node => node.classList.remove('object-selected'))
      const canvases = copy.querySelectorAll('canvas')
      original.querySelectorAll('canvas').forEach((canvas, i) => {
        const destination = canvases[i]
        destination.width = 216; destination.height = Math.max(1, Math.round(216 * canvas.height / canvas.width))
        if (canvas.width && canvas.height) destination.getContext('2d')?.drawImage(canvas, 0, 0, destination.width, destination.height)
      })
      // Isolate previews from document selection, accessibility and editor queries.
      const shadow = preview.current ??= target.current.attachShadow({ mode: 'closed' })
      const styles = [...window.document.querySelectorAll('style,link[rel="stylesheet"]')].map(style => style.cloneNode(true))
      shadow.replaceChildren(...styles, copy)
    }, 150)
    return () => window.clearTimeout(timer)
  }, [editor, index, width, revision, objects])
  return <div ref={target} className="flow-thumbnail" aria-hidden="true"/>
}

function rowsFor(page: PageModel): Row[] {
  const result: Row[] = []
  for (const block of [...page.blocks].sort((a, b) => textGeometry(page, a).top - textGeometry(page, b).top || textGeometry(page, a).left - textGeometry(page, b).left)) {
    const g = textGeometry(page, block)
    const row = result.findLast(row => Math.abs(row.bottom - (g.top + g.height)) < Math.max(2, Math.min(row.size, g.fontSize) * .3) && g.left >= row.x && g.left - row.right < Math.max(18, g.fontSize * 2))
    if (row) { row.blocks.push(block); row.right = Math.max(row.right, g.left + g.width); row.bottom = Math.max(row.bottom, g.top + g.height); row.top = Math.min(row.top, g.top) }
    else result.push({ blocks: [block], x: g.left, top: g.top, bottom: g.top + g.height, right: g.left + g.width, size: g.fontSize })
  }
  return result.sort((a, b) => a.top - b.top || a.x - b.x)
}

function lanesFor(page: PageModel, rows: Row[]): Lane[] {
  if (!rows.length) return []
  const left = Math.max(0, Math.min(...rows.map(row => row.x)))
  const right = Math.min(page.width, Math.max(page.width - Math.max(24, left), ...rows.map(row => row.right)))
  let gutter: number | undefined
  const anchors = [...new Set(rows.map(row => Math.round(row.x)))].sort((a, b) => a - b)
  for (const anchor of anchors) {
    if (anchor < left + (right - left) * .25 || anchor > left + (right - left) * .8) continue
    const a = rows.filter(row => row.right < anchor - 12), b = rows.filter(row => row.x >= anchor - 2)
    const spanning = rows.filter(row => row.x < anchor - 2 && row.right >= anchor - 12)
    if (a.length >= 2 && b.length >= 2 && spanning.length <= Math.max(1, rows.length * .12) && Math.max(a[0].top, b[0].top) < Math.min(a.at(-1)!.bottom, b.at(-1)!.bottom)) {
      gutter = (Math.max(...a.map(row => row.right)) + anchor) / 2
      break
    }
  }
  const bounds = gutter === undefined ? [[left, right]] : [[left, gutter - 8], [Math.min(...rows.filter(row => row.x > gutter!).map(row => row.x)), right]]
  return bounds.map(([x, end], index) => {
    const own = rows.filter(row => gutter === undefined || (index === 0 ? row.x < gutter : row.x >= gutter))
    return { x, top: Math.max(0, own[0]?.top ?? 40), width: Math.max(24, end - x), bottom: page.height - Math.max(24, Math.min(48, left)), rows: own }
  }).filter(lane => lane.rows.length)
}

function colour(value: string): string {
  if (value.startsWith('#')) return value
  const parts = value.match(/[\d.]+/g)?.slice(0, 3).map(Number)
  return parts?.length === 3 ? '#' + parts.map(v => Math.round(v).toString(16).padStart(2, '0')).join('') : '#000000'
}
function formatOf(node: Element): TextFormat {
  const style = getComputedStyle(node)
  let decoration = style.textDecorationLine
  for (let parent = node.parentElement; parent && !parent.classList.contains('flow-content'); parent = parent.parentElement) decoration += ' ' + getComputedStyle(parent).textDecorationLine
  return { bold: Number(style.fontWeight) >= 600 || style.fontWeight === 'bold', italic: style.fontStyle === 'italic', underline: decoration.includes('underline'), strike: decoration.includes('line-through'), fontSize: parseFloat(style.fontSize), color: colour(style.color) }
}
function textNodes(root: Node): Text[] {
  const walker = window.document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  return nodes
}

export function FlowEditor(props: Props) {
  const { document: source, zoom, editable, objects, selected } = props
  const root = useRef<HTMLDivElement>(null)
  const latest = useRef(props)
  latest.current = props
  const sections = useRef<Section[]>([])
  const history = useRef<Snapshot[]>([]), historyIndex = useRef(0), initial = useRef('')
  const historyBookmarks = useRef<Snapshot[]>([])
  const formatting = useRef(false)
  const ready = useRef<Promise<Uint8Array> | null>(null)
  const savedSelection = useRef<Range | null>(null)
  const typing = useRef(0), composing = useRef(false)
  const [objectTargets, setObjectTargets] = useState<{ source: number; continuation: number; element: HTMLDivElement }[]>([])
  const blocks = useRef(new Map(source.pages.flatMap(page => page.blocks.map(block => [block.id, block] as const))))

  function makeSheet(section: Section, continuation: boolean): Sheet {
    const model = source.pages[section.source]
    const element = window.document.createElement('div')
    element.className = 'flow-sheet'
    element.dataset.source = String(section.source)
    element.style.width = `${model.width}px`; element.style.height = `${model.height}px`
    const columns = section.lanes.map(lane => {
      const column = window.document.createElement('div')
      column.className = `flow-content${lane.footer ? ' flow-footer' : ''}`
      column.contentEditable = String(latest.current.editable)
      column.setAttribute('role', 'textbox'); column.setAttribute('aria-multiline', 'true')
      column.setAttribute('aria-label', `${lane.footer ? 'Footer text' : 'Document text'}, page ${section.source + 1}${continuation ? ' continuation' : ''}, column ${section.lanes.indexOf(lane) + 1}`)
      const top = continuation && !lane.footer ? Math.min(48, lane.top) : lane.top
      Object.assign(column.style, { left: `${lane.x}px`, top: `${top}px`, width: `${lane.width}px` })
      element.append(column)
      return column
    })
    if (continuation) section.sheets.at(-1)!.element.after(element)
    else root.current!.append(element)
    const objectTarget = window.document.createElement('div'); objectTarget.className = 'flow-object-target'; element.append(objectTarget)
    const sheet = { source: section.source, continuation, element, columns, objectTarget }
    section.sheets.push(sheet)
    return sheet
  }

  function run(block: TextBlock, text: string): HTMLSpanElement {
    const span = window.document.createElement('span')
    span.dataset.block = block.id; span.textContent = text
    const font = flowFont(block, text)
    Object.assign(span.style, { fontFamily: `"${font.family}", ${/Times|serif/i.test(block.font) ? 'serif' : 'sans-serif'}`, fontSize: `${block.originalFormat.fontSize ?? 12}px`, fontWeight: block.originalFormat.bold ? '700' : '400', fontStyle: block.originalFormat.italic ? 'italic' : 'normal', color: block.originalFormat.color ?? '#000000', textDecoration: [block.originalFormat.underline ? 'underline' : '', block.originalFormat.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none' })
    span.dataset.substituted = String(font.substituted)
    return span
  }

  function populate(column: HTMLDivElement, lane: Lane, model: PageModel) {
    let previous: Row | undefined, paragraph: HTMLDivElement | undefined, previousEnd = lane.top
    const context = window.document.createElement('canvas').getContext('2d')!
    for (const row of lane.rows) {
      const join = previous && Math.abs(row.x - previous.x) < row.size * .6 && Math.abs(row.size - previous.size) < .3 && row.top - previous.top <= row.size * 1.65
      if (!join || !paragraph) {
        paragraph = window.document.createElement('div'); paragraph.dataset.paragraph = crypto.randomUUID()
        const block = row.blocks[0], font = flowFont(block, block.text)
        context.font = `${block.originalFormat.italic ? 'italic' : 'normal'} ${block.originalFormat.bold ? '700' : '400'} ${row.size}px "${font.family}"`
        const metrics = context.measureText('Hg')
        const baselineOffset = (row.size * 1.25 - metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2 + metrics.fontBoundingBoxAscent
        const desiredTop = textGeometry(model, block).baseline[1] - baselineOffset
        const margin = previous ? Math.max(0, desiredTop - previousEnd) : desiredTop - previousEnd
        Object.assign(paragraph.style, { marginTop: `${margin}px`, marginLeft: `${Math.max(0, row.x - lane.x)}px`, fontSize: `${row.size}px`, fontFamily: `"${font.family}"`, fontWeight: block.originalFormat.bold ? '700' : '400', lineHeight: '1.25', minHeight: `${row.size * 1.25}px` })
        if (row.right > lane.x + lane.width + 4) paragraph.style.width = `${model.width - lane.x - Math.max(24, lane.x)}px`
        column.append(paragraph)
      } else if (paragraph.lastChild?.textContent && !/\s$/.test(paragraph.lastChild.textContent)) paragraph.append(window.document.createTextNode(' '))
      let end = row.x
      for (const block of row.blocks) {
        const g = textGeometry(model, block)
        if (g.left - end > row.size * .15 && paragraph.lastChild?.textContent && !/\s$/.test(paragraph.lastChild.textContent)) paragraph.append(window.document.createTextNode(' '))
        paragraph.append(run(block, block.text)); end = g.left + g.width
      }
      previousEnd = lane.top + (paragraph.getBoundingClientRect().bottom - column.getBoundingClientRect().top) / latest.current.zoom
      previous = row
    }
  }

  function bookmarkSelection() {
    const selection = window.getSelection()
    if (!selection?.rangeCount || !root.current?.contains(selection.anchorNode) || !selection.anchorNode?.parentElement?.closest('.flow-content')) return false
    const range = selection.getRangeAt(0).cloneRange()
    const end = window.document.createElement('span'), start = window.document.createElement('span')
    start.dataset.flowBookmark = 'start'; end.dataset.flowBookmark = 'end'
    for (const marker of [start, end]) { marker.setAttribute('aria-hidden', 'true'); marker.style.cssText = 'display:inline;font-size:0;line-height:0' }
    const endRange = range.cloneRange(); endRange.collapse(false); endRange.insertNode(end)
    range.collapse(true); range.insertNode(start)
    return true
  }
  function restoreBookmarks() {
    const start = root.current?.querySelector('[data-flow-bookmark="start"]'), end = root.current?.querySelector('[data-flow-bookmark="end"]')
    if (!start || !end) return
    const range = window.document.createRange()
    range.setStartAfter(start); range.setEndBefore(end)
    const selection = window.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    start.closest<HTMLElement>('.flow-content')?.focus({ preventScroll: true })
    start.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const parents = new Set([start.parentElement!, end.parentElement!])
    start.remove(); end.remove(); parents.forEach(parent => parent.normalize())
    savedSelection.current = selection.getRangeAt(0).cloneRange()
  }
  function rememberCaret() {
    if (bookmarkSelection()) { historyBookmarks.current[historyIndex.current] = snapshot(true); restoreBookmarks() }
  }

  function refreshFonts() {
    for (const node of [...root.current!.querySelectorAll('.flow-content')].flatMap(textNodes)) {
      if (!node.length) continue
      const ancestor = node.parentElement!.closest<HTMLElement>('[data-block]')
      const block = blocks.current.get(ancestor?.dataset.block ?? '') ?? blocks.current.values().next().value
      if (!block) continue
      const format = formatOf(node.parentElement!)
      try {
        const font = flowFont(block, node.data, format)
        const family = `"${font.family}", ${/Times|serif/i.test(block.font) ? 'serif' : 'sans-serif'}`
        // Only wrap when needed; ordinary keystrokes keep the same DOM node.
        if (node.parentElement!.dataset.block === block.id && [...node.parentElement!.childNodes].every(child => child.nodeType === Node.TEXT_NODE || (child instanceof HTMLElement && !!child.dataset.flowBookmark))) {
          node.parentElement!.style.fontFamily = family; node.parentElement!.dataset.substituted = String(font.substituted)
        } else {
          const span = window.document.createElement('span'); span.dataset.block = block.id; span.style.fontFamily = family; span.dataset.substituted = String(font.substituted)
          node.replaceWith(span); span.append(node)
        }
      } catch (error) { latest.current.onError(error instanceof Error ? error.message : 'This character is unavailable in the PDF font.') }
    }
  }

  function paginate() {
    const currentZoom = latest.current.zoom
    for (const section of sections.current) {
      section.lanes.forEach((lane, laneIndex) => {
        const first = section.sheets[0].columns[laneIndex]
        // Join previous page fragments before laying out again. All changes
        // happen in one frame; canvases and active text nodes stay mounted.
        const paragraphs = section.sheets.flatMap(sheet => [...sheet.columns[laneIndex].children] as HTMLElement[])
        let previous: HTMLElement | undefined
        for (const paragraph of paragraphs) {
          if (paragraph.dataset.fragment === 'true' && previous && previous.dataset.paragraph === paragraph.dataset.paragraph) { while (paragraph.firstChild) previous.append(paragraph.firstChild); paragraph.remove() }
          else { if (paragraph.dataset.gap) paragraph.style.marginTop = paragraph.dataset.gap; first.append(paragraph); previous = paragraph }
        }
        let sheetIndex = 0, column = first
        while (column.children.length) {
          const top = column.getBoundingClientRect().top
          const limit = top + (lane.bottom - parseFloat(column.style.top)) * currentZoom
          const overflowing = [...column.children].find(child => {
            // Font line boxes include invisible leading. Only move a line when
            // its actual text exceeds the boundary; otherwise a fitting last
            // line can be moved forever at fractional zoom levels.
            const probe = window.document.createRange()
            const rectangles = textNodes(child).filter(node => node.length).flatMap(node => { probe.selectNodeContents(node); return [...probe.getClientRects()].filter(rect => rect.height) })
            return (rectangles.length ? Math.max(...rectangles.map(rect => rect.bottom)) : child.getBoundingClientRect().bottom) > limit + .5 * currentZoom
          }) as HTMLElement | undefined
          if (!overflowing) break
          if (sheetIndex > 0 && parseFloat(getComputedStyle(overflowing).fontSize) > lane.bottom - parseFloat(column.style.top)) throw new Error('This font size is taller than the page. Choose a smaller size or a larger page.')
          let splitNode: Text | undefined, splitOffset = 0
          const range = window.document.createRange()
          for (const node of textNodes(overflowing)) {
            for (let offset = 0; offset < node.length; offset++) {
              range.setStart(node, offset); range.setEnd(node, offset + 1)
              const rect = range.getBoundingClientRect()
              if (rect.height && rect.bottom > limit + .5 * currentZoom) { splitNode = node; splitOffset = offset; break }
            }
            if (splitNode) break
          }
          const nextSheet = section.sheets[sheetIndex + 1] ?? makeSheet(section, true)
          const next = nextSheet.columns[laneIndex]
          if (splitNode && overflowing.getBoundingClientRect().top < limit - parseFloat(getComputedStyle(overflowing).fontSize) * currentZoom) {
            const split = window.document.createRange()
            split.setStart(splitNode, splitOffset); split.setEnd(overflowing, overflowing.childNodes.length)
            const fragment = overflowing.cloneNode(false) as HTMLElement
            fragment.dataset.fragment = 'true'; fragment.style.marginTop = '0px'; fragment.append(split.extractContents())
            if (!fragment.textContent && !fragment.querySelector('br')) { fragment.remove(); break }
            next.append(fragment)
            while (overflowing.nextElementSibling) next.append(overflowing.nextElementSibling)
          } else {
            // A whole line moves intact. Never shrink it to fit a page.
            let move: Element | null = overflowing
            while (move) { const following: Element | null = move.nextElementSibling; if (!next.childNodes.length && move instanceof HTMLElement) { move.dataset.gap ??= move.style.marginTop; move.style.marginTop = '0px' }; next.append(move); move = following }
          }
          sheetIndex++; column = next
          if (sheetIndex > 500) throw new Error('This edit creates too many continuation pages. Reduce the pasted content.')
        }
      })
      while (section.sheets.length > 1 && section.sheets.at(-1)!.columns.every(column => !column.childNodes.length)) section.sheets.pop()!.element.remove()
    }
  }

  function snapshot(withBookmarks = false): Snapshot {
    return sections.current.map(section => section.lanes.map((_, i) => section.sheets.map(sheet => {
      if (withBookmarks) return sheet.columns[i].innerHTML
      const copy = sheet.columns[i].cloneNode(true) as HTMLElement
      copy.querySelectorAll('[data-flow-bookmark]').forEach(marker => marker.remove())
      copy.normalize()
      return copy.innerHTML
    }).join('')))
  }
  function report() {
    const pageSources = sections.current.flatMap(section => section.sheets.map(() => section.source))
    const targets = sections.current.flatMap(section => section.sheets.map((sheet, continuation) => ({ source: section.source, continuation, element: sheet.objectTarget })))
    setObjectTargets(previous => previous.length === targets.length && previous.every((target, index) => target.element === targets[index].element) ? previous : targets)
    latest.current.onStatus({ dirty: JSON.stringify(snapshot()) !== initial.current, canUndo: historyIndex.current > 0, canRedo: historyIndex.current < history.current.length - 1, pages: pageSources.length, pageSources, substituted: !!root.current?.querySelector('[data-substituted="true"]') })
  }
  function remember(coalesce = false) {
    const state = snapshot(), serialized = JSON.stringify(state)
    if (serialized === JSON.stringify(history.current[historyIndex.current])) { report(); return }
    history.current = history.current.slice(0, historyIndex.current + 1)
    historyBookmarks.current = historyBookmarks.current.slice(0, historyIndex.current + 1)
    if (coalesce && historyIndex.current > 0 && Date.now() - typing.current < 500) history.current[historyIndex.current] = state
    else { history.current.push(state); historyIndex.current++ }
    historyBookmarks.current[historyIndex.current] = snapshot(true)
    if (history.current.length > 100) { history.current.shift(); historyBookmarks.current.shift(); historyIndex.current-- }
    typing.current = coalesce ? Date.now() : 0
    report()
  }
  function change(coalesce = false) {
    if (composing.current || formatting.current) return
    try {
      bookmarkSelection()
      refreshFonts(); paginate(); remember(coalesce); restoreBookmarks()
    } catch (error) {
      restoreBookmarks(); restore(historyIndex.current)
      latest.current.onError(error instanceof Error ? error.message : 'Could not lay out this edit.')
    }
  }
  function restore(index: number) {
    if (index < 0 || index >= history.current.length) return
    const state = historyBookmarks.current[index] ?? history.current[index]
    sections.current.forEach((section, s) => section.lanes.forEach((_, i) => { section.sheets.forEach(sheet => { sheet.columns[i].replaceChildren() }); section.sheets[0].columns[i].innerHTML = state[s][i] }))
    historyIndex.current = index; typing.current = 0; paginate(); restoreBookmarks(); report()
  }

  function applyFormat(patch: TextFormat) {
    const range = savedSelection.current
    if (!range || !root.current?.contains(range.startContainer)) return
    const selection = window.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    rememberCaret(); formatting.current = true
    for (const [key, command] of [['bold', 'bold'], ['italic', 'italic'], ['underline', 'underline'], ['strike', 'strikeThrough']] as const) if (patch[key] !== undefined) window.document.execCommand(command)
    if (patch.color) window.document.execCommand('foreColor', false, patch.color)
    if (patch.fontSize !== undefined && Number.isFinite(patch.fontSize) && patch.fontSize >= 1 && patch.fontSize <= 300) {
      window.document.execCommand('fontSize', false, '7')
      root.current.querySelectorAll('font[size="7"]').forEach(element => { const span = window.document.createElement('span'); span.style.fontSize = `${patch.fontSize}px`; while (element.firstChild) span.append(element.firstChild); element.replaceWith(span) })
    }
    formatting.current = false; change(); saveSelection()
  }
  function saveSelection() {
    const selection = window.getSelection()
    if (selection?.rangeCount && root.current?.contains(selection.anchorNode) && selection.anchorNode?.parentElement?.closest('.flow-content')) {
      savedSelection.current = selection.getRangeAt(0).cloneRange()
      latest.current.onFormat(formatOf(selection.anchorNode.parentElement))
    }
  }

  function crossPage(key: string): boolean {
    const selection = window.getSelection()
    if (!selection?.rangeCount || !selection.isCollapsed) return false
    const range = selection.getRangeAt(0), column = selection.anchorNode?.parentElement?.closest('.flow-content')
    if (!column) return false
    const section = sections.current.find(section => section.sheets.some(sheet => sheet.columns.includes(column as HTMLDivElement)))
    if (!section) return false
    const sheetIndex = section.sheets.findIndex(sheet => sheet.columns.includes(column as HTMLDivElement)), laneIndex = section.sheets[sheetIndex].columns.indexOf(column as HTMLDivElement)
    const prefix = window.document.createRange(); prefix.selectNodeContents(column); prefix.setEnd(range.startContainer, range.startOffset)
    const suffix = window.document.createRange(); suffix.selectNodeContents(column); suffix.setStart(range.endContainer, range.endOffset)
    const backwards = ['Backspace', 'ArrowLeft', 'ArrowUp'].includes(key)
    if ((backwards ? prefix.toString() : suffix.toString()).length) return false
    const target = section.sheets[sheetIndex + (backwards ? -1 : 1)]?.columns[laneIndex]
    if (!target) return false
    const nodes = textNodes(target), node = backwards ? nodes.at(-1) : nodes[0]
    if (!node) return false
    rememberCaret(); target.focus()
    const moved = window.document.createRange(); moved.setStart(node, backwards ? node.length : 0); moved.collapse(true)
    selection.removeAllRanges(); selection.addRange(moved)
    if (key === 'Backspace' || key === 'Delete') window.document.execCommand(key === 'Backspace' ? 'delete' : 'forwardDelete')
    saveSelection()
    return true
  }

  function placements(sheet: Sheet): FlowPlacement[] {
    const sheetRect = sheet.element.getBoundingClientRect(), scale = latest.current.zoom
    const lines: FlowPlacement[] = []
    const context = window.document.createElement('canvas').getContext('2d')!
    const metrics = new Map<string, number>()
    for (const node of [...sheet.element.querySelectorAll('.flow-content')].flatMap(textNodes)) {
      const parent = node.parentElement!, blockId = parent.closest<HTMLElement>('[data-block]')?.dataset.block
      if (!blockId || !node.data) continue
      const style = getComputedStyle(parent), format = formatOf(parent)
      const key = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      let ascent = metrics.get(key)
      if (ascent === undefined) { context.font = key; ascent = context.measureText('Hg').fontBoundingBoxAscent; metrics.set(key, ascent) }
      const range = window.document.createRange()
      let offset = 0, current: FlowPlacement | undefined, currentTop = 0
      for (const char of node.data) {
        range.setStart(node, offset); offset += char.length; range.setEnd(node, offset)
        const rect = range.getBoundingClientRect()
        if (!rect.height || /[\r\n]/.test(char)) continue
        const x = (rect.left - sheetRect.left) / scale, y = (rect.top - sheetRect.top) / scale
        if (!current || Math.abs(y - currentTop) > .5) {
          current = { blockId, text: char, x, baseline: y + ascent, width: rect.width / scale, format }; currentTop = y; lines.push(current)
        } else { current.text += char; current.width = (rect.right - sheetRect.left) / scale - current.x }
      }
    }
    return lines
  }

  useImperativeHandle(props.ref, () => ({
    export: async () => {
      const background = await ready.current
      if (!background) throw new Error('The flow editor is still opening the PDF.')
      change()
      const pages: FlowOutputPage[] = sections.current.flatMap(section => section.sheets.map(sheet => ({ source: sheet.source, continuation: sheet.continuation, lines: placements(sheet) })))
      const sourcePages = source.pages.map((_, index) => pages.findIndex(page => page.source === index && !page.continuation))
      const models = pages.map(page => page.continuation ? { ...source.pages[page.source], rotation: 0, viewportTransform: [1, 0, 0, -1, 0, source.pages[page.source].height] } : source.pages[page.source])
      return { bytes: JSON.stringify(snapshot()) === initial.current ? source.bytes : await exportFlowDocument(source, background, pages), pages: models, sourcePages }
    },
    undo: () => restore(historyIndex.current - 1), redo: () => restore(historyIndex.current + 1), format: applyFormat,
    scrollToPage: index => sections.current[index]?.sheets[0].element.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    scrollToSheet: index => sections.current.flatMap(section => section.sheets)[index]?.element.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    pageElement: index => sections.current.flatMap(section => section.sheets)[index]?.element,
  }))

  useEffect(() => {
    let cancelled = false, backgroundProxy: pdfjs.PDFDocumentProxy | undefined
    let observer: IntersectionObserver | undefined
    const tasks: pdfjs.RenderTask[] = []
    root.current!.replaceChildren(); sections.current = []; blocks.current = new Map(source.pages.flatMap(page => page.blocks.map(block => [block.id, block] as const)))
    const initialize = async () => {
      const background = await textFreeDocument(source)
      if (cancelled) return background
      backgroundProxy = await pdfjs.getDocument({ ...pdfOptions, data: background.slice() }).promise
      if (cancelled) { await backgroundProxy.loadingTask.destroy(); return background }
      await window.document.fonts.ready
      async function renderBackground(canvas: HTMLCanvasElement, index: number) {
        try {
          const model = source.pages[index], page = await backgroundProxy!.getPage(index + 1)
          if (cancelled) return
          const ratio = Math.min(2, 8192 / Math.max(model.width, model.height), Math.sqrt(20_000_000 / (model.width * model.height)))
          canvas.width = Math.ceil(model.width * ratio); canvas.height = Math.ceil(model.height * ratio)
          canvas.style.width = `${model.width}px`; canvas.style.height = `${model.height}px`
          const task = page.render({ canvas, viewport: page.getViewport({ scale: ratio }) }); tasks.push(task); await task.promise
          canvas.dataset.ready = 'true'
          if (root.current?.dataset.ready === 'true') report()
        } catch (error) { if (!cancelled) latest.current.onError(error instanceof Error ? error.message : 'Could not render the page artwork.') }
      }
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) { observer!.unobserve(entry.target); void renderBackground(entry.target as HTMLCanvasElement, Number((entry.target as HTMLElement).dataset.source)) }
      }, { root: root.current!.closest('.workspace'), rootMargin: '800px' })
      for (let index = 0; index < source.pages.length; index++) {
        const model = source.pages[index], rows = rowsFor(model)
        const fixed = rows.filter(row => row.top > model.height - Math.max(50, model.height * .065))
        const section: Section = { source: index, lanes: lanesFor(model, rows.filter(row => !fixed.includes(row))), sheets: [] }
        if (fixed.length) section.lanes.forEach(lane => { lane.bottom = Math.min(lane.bottom, Math.min(...fixed.map(row => row.top)) - 12) })
        section.lanes.push(...lanesFor(model, fixed).map(lane => ({ ...lane, footer: true, bottom: model.height - 4 })))
        sections.current.push(section)
        const sheet = makeSheet(section, false)
        const canvas = window.document.createElement('canvas'); canvas.className = 'flow-background'; sheet.element.prepend(canvas)
        canvas.dataset.source = String(index)
        if (index === 0) await renderBackground(canvas, index)
        else observer.observe(canvas)
        if (cancelled) return background
        section.lanes.forEach((lane, i) => populate(sheet.columns[i], lane, model))
      }
      if (cancelled) return background
      refreshFonts(); paginate(); initial.current = JSON.stringify(snapshot()); history.current = [snapshot()]; historyBookmarks.current = [snapshot()]; historyIndex.current = 0
      root.current!.dataset.ready = 'true'; report()
      return background
    }
    ready.current = initialize()
    void ready.current.catch(error => { if (!cancelled) latest.current.onError(error instanceof Error ? error.message : 'Could not prepare flowing text.') })
    const selection = () => saveSelection()
    window.document.addEventListener('selectionchange', selection)
    return () => { cancelled = true; observer?.disconnect(); tasks.forEach(task => task.cancel()); void backgroundProxy?.loadingTask.destroy(); window.document.removeEventListener('selectionchange', selection) }
    // This editor owns its editable DOM. Parent updates must not replace it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])
  useEffect(() => { root.current?.querySelectorAll<HTMLElement>('.flow-content').forEach(element => { element.contentEditable = String(editable) }) }, [editable])

  return <div className="flow-document" ref={root} style={{ zoom }} onFocus={event => { if (event.target instanceof HTMLElement && event.target.closest('.flow-content')) { const sheet = event.target.closest<HTMLElement>('.flow-sheet')!; props.onFocusText(Number(sheet.dataset.source), [...root.current!.children].indexOf(sheet)) } }} onBeforeInput={() => { if (!formatting.current && !composing.current) rememberCaret() }} onInput={event => { if (event.target instanceof HTMLElement && event.target.closest('.flow-content')) change((event.nativeEvent as InputEvent).inputType === 'insertText') }} onCompositionStart={() => { rememberCaret(); composing.current = true }} onCompositionEnd={() => { composing.current = false; change() }} onPaste={event => {
    if (!(event.target instanceof HTMLElement) || !event.target.closest('.flow-content')) return
    event.preventDefault(); window.document.execCommand('insertText', false, event.clipboardData.getData('text/plain'))
  }} onKeyDown={event => {
    if (!(event.target instanceof HTMLElement) || !event.target.closest('.flow-content')) return
    if (!event.shiftKey && ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && crossPage(event.key)) { event.preventDefault(); event.stopPropagation(); return }
    if (!(event.ctrlKey || event.metaKey)) return
    const key = event.key.toLowerCase()
    if (key === 'z' || key === 'y') { event.preventDefault(); event.stopPropagation(); restore(historyIndex.current + (key === 'y' || event.shiftKey ? 1 : -1)) }
    if (['b', 'i', 'u'].includes(key)) { event.preventDefault(); event.stopPropagation(); saveSelection(); const format = formatOf(window.getSelection()!.anchorNode!.parentElement!); const field = key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'underline'; applyFormat({ [field]: !format[field] }) }
  }}>
    {objectTargets.map(target => {
      const matches = (object: AddedObject) => object.page === target.source && Math.min(object.flowContinuation ?? 0, sections.current[target.source].sheets.length - 1) === target.continuation
      return createPortal(<ObjectLayer objects={objects.filter(matches)} selected={selected && matches(selected) ? selected : null} page={source.pages[target.source]} zoom={1} interactionZoom={zoom} editable={editable} onSelect={props.onSelectObject} onChange={props.onChangeObject} onCommit={props.onCommitObject}/>, target.element, `${target.source}-${target.continuation}`)
    })}
  </div>
}
