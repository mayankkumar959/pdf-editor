import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent, PointerEvent, ReactNode } from 'react'
import * as pdfjs from 'pdfjs-dist'
import { createDemo, exportDocument, fontForEdit, hitTestText, layoutText, openDocument, pdfOptions, resizeTextBox, textBoxGeometry, textGeometry, validateEdit } from './pdfEngine'
import type { EditorDocument, Edits, TextBlock, TextBoxes, TextBoxSize, TextFormat, TextFormats, TextGeometry } from './pdfEngine'
import { FormattingControls } from './TextControls'
import { PointInput } from './TextControls'
import { addObjects, constrainObject, extractPages, imageFile, mergeDocuments, prepareObjectFonts, sameObject, saveFile, splitDocuments, validateObject, zipFiles } from './documentTools'
import type { AddedObject, MergeFile } from './documentTools'
import { ObjectLayer, ObjectProperties } from './ObjectTools'
import { MergeDialog, SignatureDialog, SplitDialog } from './ToolDialogs'
import './App.css'

type IconName = 'document' | 'upload' | 'download' | 'chevron' | 'text' | 'undo' | 'redo' | 'close' | 'check' | 'lock' | 'expand' | 'plus' | 'minus'
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    document: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></>,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></>,
    download: <><path d="M12 3v13m-5-5 5 5 5-5M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></>,
    chevron: <path d="m9 6 6 6-6 6"/>, text: <><path d="M4 5h16M12 5v15M8 20h8M4 5v3m16-3v3"/></>,
    undo: <><path d="M8 5 3 10l5 5M3 10h11a6 6 0 0 1 0 12"/></>, redo: <><path d="m16 5 5 5-5 5M21 10H10a6 6 0 0 0 0 12"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>, check: <path d="m5 12 4 4L19 6"/>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></>,
    expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>, plus: <path d="M12 5v14M5 12h14"/>, minus: <path d="M5 12h14"/>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function PdfCanvas({ proxy, pageNumber, scale, thumbnail = false, onError }: { proxy: pdfjs.PDFDocumentProxy; pageNumber: number; scale: number; thumbnail?: boolean; onError?: (message: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let cancelled = false
    let task: pdfjs.RenderTask | undefined
    let observer: IntersectionObserver | undefined
    const canvas = ref.current!
    async function render() {
      try {
        canvas.dataset.renderState = 'pending'
        const page = await proxy.getPage(pageNumber)
        if (cancelled) return
        const viewport = page.getViewport({ scale })
        const ratio = Math.min(window.devicePixelRatio || 1, 2, 8192 / Math.max(viewport.width, viewport.height), Math.sqrt(20_000_000 / (viewport.width * viewport.height)))
        canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
        canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        task = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
        await task.promise
        if (!cancelled) canvas.dataset.renderState = 'ready'
      } catch (error) { if (!cancelled) onError?.(error instanceof Error ? error.message : 'Page could not be rendered.') }
    }
    if (thumbnail) { observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); void render() } }); observer.observe(canvas) }
    else void render()
    return () => { cancelled = true; observer?.disconnect(); task?.cancel() }
  }, [proxy, pageNumber, scale, thumbnail, onError])
  return <canvas ref={ref} className={thumbnail ? 'thumbnail-canvas' : 'document-canvas'} aria-label={`PDF page ${pageNumber}`} />
}

function TextBoxControls({ geometry, style, zoom, disabled, onResize }: { geometry: TextGeometry; style: CSSProperties; zoom: number; disabled: boolean; onResize: (size: TextBoxSize, focusEditor?: boolean) => void }) {
  const drag = useRef<{ x: number; y: number; width: number; height: number; axis: 'width' | 'height' | 'both' } | null>(null)
  function start(event: PointerEvent<HTMLButtonElement>, axis: 'width' | 'height' | 'both') {
    event.preventDefault(); event.stopPropagation()
    drag.current = { x: event.clientX, y: event.clientY, width: geometry.width, height: geometry.height, axis }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    if (!(event.buttons & 1)) { drag.current = null; return }
    if (!drag.current) return
    const current = drag.current
    const dx = (event.clientX - current.x) / zoom, dy = (event.clientY - current.y) / zoom
    const [a, b] = geometry.right, [c, d] = geometry.down
    const determinant = a * d - b * c
    if (Math.abs(determinant) < 0.000001) return
    onResize({ width: current.width + (current.axis === 'height' ? 0 : (d * dx - c * dy) / determinant), height: current.height + (current.axis === 'width' ? 0 : (-b * dx + a * dy) / determinant) })
  }
  return <div className="resize-frame" style={style} aria-label="Selected text box">
    {(['width', 'height', 'both'] as const).map(axis => <button key={axis} type="button" className={`resize-handle resize-${axis}`} aria-label={axis === 'both' ? 'Resize text box' : `Resize text box ${axis}`} title="Drag to resize; arrow keys adjust by 5 pt" disabled={disabled} onPointerDown={event => start(event, axis)} onPointerMove={move} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      const step = event.shiftKey ? 20 : 5
      onResize({ width: geometry.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), height: geometry.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0) }, false)
    }}/>) }
    <span className="resize-size">{geometry.width.toFixed(0)} × {geometry.height.toFixed(0)} pt</span>
  </div>
}

type EditorState = { edits: Edits; boxes: TextBoxes; formats: TextFormats; objects: AddedObject[] }

function App() {
  const [document, setDocument] = useState<EditorDocument | null>(null)
  const [preview, setPreview] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [mode, setMode] = useState<'edit' | 'view'>('edit')
  const [fileName, setFileName] = useState('')
  const [history, setHistory] = useState<EditorState[]>([{ edits: {}, boxes: {}, formats: {}, objects: [] }])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [inlineEditing, setInlineEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftBox, setDraftBox] = useState<TextBoxSize | undefined>()
  const [draftFormat, setDraftFormat] = useState<TextFormat | undefined>()
  const [busy, setBusy] = useState('')
  const [previewBusy, setPreviewBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [dragging, setDragging] = useState(false)
  const [objectDraft, setObjectDraft] = useState<AddedObject | null>(null)
  const [tool, setTool] = useState<'signature' | 'merge' | 'split' | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const imageKind = useRef<'image' | 'signature'>('image')
  const fileInput = useRef<HTMLInputElement>(null)
  const textInput = useRef<HTMLTextAreaElement>(null)
  const inlineInput = useRef<HTMLInputElement>(null)
  const workspace = useRef<HTMLDivElement>(null)
  const loadGeneration = useRef(0)
  const latestDocument = useRef<EditorDocument | null>(null)
  const latestPreview = useRef<pdfjs.PDFDocumentProxy | null>(null)
  const { edits, boxes, formats, objects } = history[historyIndex]
  const latestState = useRef(history[historyIndex])
  const latestHistoryIndex = useRef(historyIndex)
  useLayoutEffect(() => { latestState.current = history[historyIndex]; latestHistoryIndex.current = historyIndex }, [history, historyIndex])
  const objectChanged = !!objectDraft && !sameObject(objectDraft, objects.find(object => object.id === objectDraft.id))
  const page = document?.pages[pageIndex]
  const selected = page?.blocks.find(block => block.id === selectedId)
  const changedCount = new Set([...Object.keys(edits), ...Object.keys(boxes), ...Object.keys(formats)]).size + objects.length
  const candidateBoxes = selected ? { ...boxes, ...(draftBox ? { [selected.id]: draftBox } : {}) } : boxes
  const candidateFormats = selected ? { ...formats, [selected.id]: draftFormat ?? {} } : formats
  const draftError = document && selected ? validateEdit(document, selected, draft, draftBox, candidateBoxes, draftFormat, candidateFormats, edits) ?? page!.blocks.reduce<string | null>((error, block) => error ?? (block.id !== selected.id && (edits[block.id] !== undefined || boxes[block.id] || formats[block.id]) ? validateEdit(document, block, edits[block.id] ?? block.text, boxes[block.id], candidateBoxes, formats[block.id], candidateFormats, edits) : null), null) : null
  const draftChanged = !!selected && (draft !== (edits[selected.id] ?? selected.text) || draftBox?.width !== boxes[selected.id]?.width || draftBox?.height !== boxes[selected.id]?.height || JSON.stringify(draftFormat ?? {}) !== JSON.stringify(formats[selected.id] ?? {}))
  const draftLayout = selected && page && !draftError ? layoutText(page, selected, draft, draftBox, candidateBoxes, draftFormat, candidateFormats, edits) : null
  const draftFont = selected && !draftError ? fontForEdit(selected, draft, draftFormat) : null
  const selectedGeometry = selected && page ? draftLayout?.slot ?? textBoxGeometry(page, selected, draftBox, boxes) : null
  const activeFormat = selected ? { ...selected.originalFormat, ...draftFormat } : {}

  async function load(bytes: Uint8Array, filename: string) {
    const generation = ++loadGeneration.current
    setBusy('Opening your PDF…'); setError(''); setNotice('')
    try {
      const opened = await openDocument(bytes)
      if (generation !== loadGeneration.current) { await opened.proxy.loadingTask.destroy(); return }
      const previous = latestDocument.current
      latestDocument.current = opened
      const previousPreview = latestPreview.current
      latestPreview.current = null
      setDocument(opened); setPreview(null); setFileName(filename.replace(/\.pdf$/i, '-edited.pdf'))
      setHistory([{ edits: {}, boxes: {}, formats: {}, objects: [] }]); setHistoryIndex(0); setPageIndex(0); setSelectedId(null); setObjectDraft(null); setDraftBox(undefined); setDraftFormat(undefined); setMode('edit')
      const availableWidth = window.innerWidth - (window.innerWidth <= 560 ? 0 : window.innerWidth <= 800 ? 233 : window.innerWidth <= 1100 ? 400 : window.innerWidth >= 1600 ? 496 : 452)
      setZoom(Math.min(1, Math.max(0.25, (availableWidth - 96) / opened.pages[0].width)))
      // Let canvas effects clean up before releasing the previous PDF worker.
      if (previous) window.setTimeout(() => { void previous.proxy.loadingTask.destroy() }, 100)
      if (previousPreview) window.setTimeout(() => { void previousPreview.loadingTask.destroy() }, 100)
    } catch (cause) {
      if (generation === loadGeneration.current) setError(cause instanceof Error && cause.name === 'PasswordException' ? 'This PDF is password-protected. Open an unlocked copy to edit it.' : 'Could not open this PDF. Check that the file is a valid, unencrypted PDF.')
    } finally { if (generation === loadGeneration.current) setBusy('') }
  }

  async function upload(file?: File) {
    if (!file) return
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { setError('Please choose a PDF file.'); return }
    try { await load(new Uint8Array(await file.arrayBuffer()), file.name) }
    catch { setError('Could not read this file. Choose an accessible local PDF and try again.') }
  }

  useEffect(() => {
    if (!document) return
    let cancelled = false
    let owned: pdfjs.PDFDocumentProxy | undefined
    let loading: pdfjs.PDFDocumentLoadingTask | undefined
    void (async () => {
      try {
        await Promise.resolve()
        if (cancelled) return
        if (!Object.keys(edits).length && !Object.keys(boxes).length && !Object.keys(formats).length) {
          const previous = latestPreview.current
          latestPreview.current = null
          setPreview(null); setPreviewBusy(false)
          if (previous) window.setTimeout(() => { void previous.loadingTask.destroy() }, 100)
          return
        }
        setPreviewBusy(true)
        const bytes = await exportDocument(document, edits, boxes, formats)
        if (cancelled) return
        loading = pdfjs.getDocument({ ...pdfOptions, data: bytes })
        owned = await loading.promise
        if (cancelled) { await owned.loadingTask.destroy(); return }
        const previous = latestPreview.current
        latestPreview.current = owned
        setPreview(owned); setPreviewBusy(false)
        if (previous) window.setTimeout(() => { void previous.loadingTask.destroy() }, 100)
      } catch (cause) { if (!cancelled) { setError(cause instanceof Error ? cause.message : 'Could not update the preview.'); setPreviewBusy(false) } }
    })()
    return () => { cancelled = true; if (loading && !owned) void loading.destroy() }
  }, [document, edits, boxes, formats])

  useEffect(() => () => {
    loadGeneration.current++
    void latestDocument.current?.proxy.loadingTask.destroy()
    void latestPreview.current?.loadingTask.destroy()
  }, [])

  useEffect(() => {
    if (selectedId && inlineEditing) { inlineInput.current?.focus(); inlineInput.current?.select() }
  }, [selectedId, inlineEditing])

  function record(next: Edits, nextBoxes: TextBoxes = boxes, nextFormats: TextFormats = formats, nextObjects: AddedObject[] = objects) {
    const state = { edits: next, boxes: nextBoxes, formats: nextFormats, objects: nextObjects }
    latestState.current = state
    const index = latestHistoryIndex.current + 1
    latestHistoryIndex.current = index
    setHistory(previous => [...previous.slice(0, index), state])
    setHistoryIndex(index); setNotice('')
  }

  function applyDraft(): EditorState | null {
    if (objectDraft && objectChanged && document) {
      const error = validateObject(objectDraft, document.pages)
      if (error) { setError(error); return null }
      const nextObjects = objects.map(object => object.id === objectDraft.id ? objectDraft : object)
      record(edits, boxes, formats, nextObjects); setError('')
      return { edits, boxes, formats, objects: nextObjects }
    }
    if (!selected || !draftChanged) { setInlineEditing(false); return { edits, boxes, formats, objects } }
    if (draftError) { setError(draftError); return null }
    const next = { ...edits }
    if (draft === selected.text) delete next[selected.id]
    else next[selected.id] = draft
    const nextBoxes = { ...boxes }
    if (draftBox) nextBoxes[selected.id] = draftBox
    else delete nextBoxes[selected.id]
    const nextFormats = { ...formats }
    if (draftFormat) nextFormats[selected.id] = draftFormat
    else delete nextFormats[selected.id]
    record(next, nextBoxes, nextFormats); setError(''); setInlineEditing(false); return { edits: next, boxes: nextBoxes, formats: nextFormats, objects }
  }

  function select(block: TextBlock, edit = false) {
    if (selectedId === block.id) {
      if (edit) setInlineEditing(true)
      return
    }
    const next = draftChanged || objectChanged ? applyDraft() : { edits, boxes, formats, objects }
    if (!next) return
    setObjectDraft(null); setSelectedId(block.id); setDraft(next.edits[block.id] ?? block.text); setDraftBox(next.boxes[block.id]); setDraftFormat(next.formats[block.id]); setInlineEditing(edit); setError('')
  }

  function doubleClickText(event: MouseEvent<HTMLDivElement>) {
    if (!page || busy || previewBusy) return
    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const block = hitTestText(page, edits, (event.clientX - bounds.left) / zoom, (event.clientY - bounds.top) / zoom, 4 / zoom, boxes, formats)
    if (block) select(block, true)
  }

  function navigate(index: number) {
    if ((draftChanged || objectChanged) && !applyDraft()) return
    setPageIndex(index); setSelectedId(null); setObjectDraft(null); workspace.current?.scrollTo({ top: 0, left: 0 })
  }

  function undo() { if (historyIndex > 0) { setHistoryIndex(historyIndex - 1); setSelectedId(null); setObjectDraft(null); setError('') } }
  function redo() { if (historyIndex < history.length - 1) { setHistoryIndex(historyIndex + 1); setSelectedId(null); setObjectDraft(null); setError('') } }

  async function exportState(state: EditorState) {
    if (!document) throw new Error('Open a PDF first.')
    return addObjects(await exportDocument(document, state.edits, state.boxes, state.formats), document.pages, state.objects)
  }

  async function download() {
    if (!document || busy) return
    const next = applyDraft()
    if (!next) return
    setBusy('Preparing your PDF…'); setError('')
    try {
      const bytes = await exportState(next)
      saveFile(bytes, (fileName.trim() || 'edited.pdf').replace(/(?:\.pdf)?$/i, '.pdf'))
      setNotice('Your edited PDF is ready. Download complete.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this PDF.') }
    finally { setBusy('') }
  }

  function updateFormat(patch: TextFormat, focusEditor = true) {
    if (!selected) return
    const next = { ...draftFormat, ...patch }
    for (const key of Object.keys(next) as (keyof TextFormat)[]) if (next[key] === selected.originalFormat[key]) delete next[key]
    setDraftFormat(Object.keys(next).length ? next : undefined); if (focusEditor) setInlineEditing(true); setError('')
  }

  function selectObject(object: AddedObject): boolean {
    if (objectDraft?.id === object.id) return true
    if ((draftChanged || objectChanged) && !applyDraft()) return false
    setSelectedId(null); setInlineEditing(false); setObjectDraft(object); setError(''); return true
  }
  function commitObject(object: AddedObject) {
    if (!document) return
    setObjectDraft(object)
    const error = validateObject(object, document.pages)
    if (error) { setError(error); return }
    const current = latestState.current
    if (sameObject(object, current.objects.find(value => value.id === object.id))) return
    record(current.edits, current.boxes, current.formats, current.objects.map(value => value.id === object.id ? object : value)); setError('')
  }
  function insertObject(object: AddedObject) {
    if (!page) return
    const constrained = constrainObject(object, page), state = latestState.current
    record(state.edits, state.boxes, state.formats, [...state.objects, constrained])
    setSelectedId(null); setInlineEditing(false); setObjectDraft(constrained); setMode('edit'); setTool(null); setError('')
  }
  async function addText() {
    if (!page || !applyDraft()) return
    setBusy('Preparing text box...')
    try { await prepareObjectFonts(); insertObject({ id: crypto.randomUUID(), kind: 'text', page: pageIndex, x: 40, y: 40, width: Math.min(240, page.width), height: 65, text: 'New text', family: 'Helvetica', format: { fontSize: 16, color: '#000000' } }) }
    catch { setError('Could not create a text box. Please try again.') }
    finally { setBusy('') }
  }
  function insertImage(data: string, width: number, height: number, kind: 'image' | 'signature', label: string) {
    if (!page) return
    const scale = Math.min(1, 240 / width, 180 / height, page.width / width, page.height / height)
    insertObject({ id: crypto.randomUUID(), kind, page: pageIndex, x: 40, y: 80, width: width * scale, height: height * scale, data, label })
  }
  function chooseImage(kind: 'image' | 'signature') {
    if (!applyDraft()) return
    imageKind.current = kind; imageInput.current?.click()
  }
  async function uploadImage(file?: File) {
    if (!file || !document) return
    setBusy('Adding image...'); setError('')
    try { const image = await imageFile(file); insertImage(image.data, image.width, image.height, imageKind.current, file.name) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add this image.') }
    finally { setBusy('') }
  }
  function deleteObject() {
    if (!objectDraft) return
    record(edits, boxes, formats, objects.filter(object => object.id !== objectDraft.id)); setObjectDraft(null); setError('')
  }
  function openTool(next: 'signature' | 'merge' | 'split') { if (!document || applyDraft()) { setError(''); setTool(next) } }
  async function merge(files: MergeFile[]) {
    setBusy('Merging PDFs...'); setError('')
    try {
      const sources: Uint8Array[] = []
      for (const file of files) sources.push(file.bytes ?? await exportState(latestState.current))
      const bytes = await mergeDocuments(sources)
      await load(bytes, 'merged.pdf'); setTool(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not merge these PDFs.') }
    finally { setBusy('') }
  }
  async function split(groups: number[][], zip: boolean) {
    setBusy('Splitting PDF...'); setError('')
    try {
      const bytes = await exportState(latestState.current), base = (fileName.trim() || 'document.pdf').replace(/\.pdf$/i, '')
      if (!zip) saveFile(await extractPages(bytes, groups[0]), `${base}-extracted.pdf`)
      else {
        const parts = (await splitDocuments(bytes, groups)).map((bytes, index) => ({ name: `part-${String(index + 1).padStart(3, '0')}.pdf`, bytes }))
        saveFile(zipFiles(parts), `${base}-split.zip`, 'application/zip')
      }
      setTool(null); setNotice('Your selected pages are ready. Download complete.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not split this PDF.') }
    finally { setBusy('') }
  }

  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (tool || busy) return
      if (objectDraft && event.key === 'Delete' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); deleteObject(); return }
      if (!(event.ctrlKey || event.metaKey)) return
      if (objectDraft?.kind === 'text' && ['b', 'i', 'u'].includes(event.key.toLowerCase())) {
        event.preventDefault()
        const key = event.key.toLowerCase() === 'b' ? 'bold' : event.key.toLowerCase() === 'i' ? 'italic' : 'underline'
        setObjectDraft(constrainObject({ ...objectDraft, format: { ...objectDraft.format, [key]: !objectDraft.format[key] } }, page!)); return
      }
      if (selected && ['b', 'i', 'u'].includes(event.key.toLowerCase())) {
        event.preventDefault()
        const key = event.key.toLowerCase() === 'b' ? 'bold' : event.key.toLowerCase() === 'i' ? 'italic' : 'underline'
        updateFormat({ [key]: !activeFormat[key] }); return
      }
      if (event.key.toLowerCase() === 's') { event.preventDefault(); void download() }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      if (event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo() }
      if (event.key.toLowerCase() === 'y') { event.preventDefault(); redo() }
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  })

  function inlineStyle(block: TextBlock): CSSProperties {
    const activeFont = draftFont?.name ?? block.font
    const font = activeFont.replace(/-(BoldItalic|BoldOblique|Bold|Italic|Oblique|Roman)$/, '')
    const family = /Helvetica|Arial/.test(font) ? 'Arial' : /Times/.test(font) ? 'Times New Roman' : /Courier/.test(font) ? 'Courier New' : font
    const slot = { ...(draftLayout?.slot ?? selectedGeometry ?? textGeometry(page!, block)), height: Math.max(textGeometry(page!, block).height, draftLayout?.geometry.height ?? 0) }
    const size = (draftLayout?.fontSize ?? slot.fontSize) * zoom
    return { ...geometryStyle(slot), fontFamily: '"' + family.replace(/"/g, '') + '", ' + (/Times|Serif/.test(font) ? 'serif' : 'sans-serif'), fontSize: size, fontWeight: activeFormat.bold ? 700 : 400, fontStyle: activeFormat.italic ? 'italic' : 'normal', textDecorationLine: [activeFormat.underline ? 'underline' : '', activeFormat.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none', color: activeFormat.color ?? '#000000' }
  }

  function fit() { if (page) setZoom(Math.min(2, Math.max(0.25, ((workspace.current?.clientWidth ?? 800) - 96) / page.width))) }
  function blockStyle(block: TextBlock): CSSProperties {
    let geometry = textBoxGeometry(page!, block, boxes[block.id], boxes)
    if ((edits[block.id] !== undefined && edits[block.id] !== '') || formats[block.id]) {
      try {
        const layout = layoutText(page!, block, edits[block.id] ?? block.text, boxes[block.id], boxes, formats[block.id], formats, edits)
        geometry = boxes[block.id] ? layout.slot : layout.geometry
      } catch { /* Keep selection available if an existing edit needs correction. */ }
    }
    return geometryStyle(geometry)
  }

  function resizeSelected(size: TextBoxSize, focusEditor = true) {
    if (!page || !selected) return
    setDraftBox(resizeTextBox(page, selected, size, boxes, formats, edits)); setError('')
    if (focusEditor) setInlineEditing(true)
  }

  function discardDraft() {
    if (!selected) return
    setDraft(edits[selected.id] ?? selected.text); setDraftBox(boxes[selected.id]); setDraftFormat(formats[selected.id]); setError('')
  }



  function geometryStyle(geometry: TextGeometry): CSSProperties {
    return { left: geometry.left * zoom, top: geometry.top * zoom, width: geometry.width * zoom, height: geometry.height * zoom, transform: `matrix(${geometry.right[0]},${geometry.right[1]},${geometry.down[0]},${geometry.down[1]},0,0)`, transformOrigin: '0 0' }
  }

  const activeProxy = changedCount ? preview ?? document?.proxy : document?.proxy
  return (
    <div className="app" onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true) }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false) }} onDrop={event => { event.preventDefault(); setDragging(false); if (!busy) void upload(event.dataTransfer.files[0]) }}>
      <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" hidden aria-label="Upload image or signature" onChange={event => { void uploadImage(event.target.files?.[0]); event.target.value = '' }} />
      <input ref={fileInput} id="file-upload" type="file" accept="application/pdf,.pdf" hidden onChange={event => { void upload(event.target.files?.[0]); event.target.value = '' }} />
      <header className="app-header">
        <div className="brand" aria-label="Papyora PDF editor"><img className="brand-mark" src="/papyora-icon.svg" alt=""/><span>papyora<span className="brand-dot">.</span></span><span className="brand-label">PDF STUDIO</span></div>
        <div className="privacy"><span className="status-dot"/><span>Private by design</span><span className="privacy-detail"> · Files stay on your device</span></div>
        <button className="button secondary" disabled={!!busy} onClick={() => fileInput.current?.click()}><Icon name="upload"/>{document ? 'Open PDF' : 'Upload PDF'}</button>
        <button className="button primary" disabled={!document || !!busy} onClick={() => void download()}><Icon name="download"/>Download PDF</button>
      </header>

      {document ? <>
        <div className="editor-toolbar">
          <div className="document-name"><Icon name="document"/><input aria-label="Download filename" value={fileName} onChange={event => setFileName(event.target.value)} /><span className="file-badge">PDF</span></div>
          <div className="mode-switch" aria-label="Editor mode"><button className={mode === 'edit' ? 'selected' : ''} onClick={() => setMode('edit')}><Icon name="text" size={15}/>Edit text</button><button className={mode === 'view' ? 'selected' : ''} onClick={() => { if ((!draftChanged && !objectChanged) || applyDraft()) { setMode('view'); setSelectedId(null); setObjectDraft(null) } }}>View</button></div>
          <div className="toolbar-actions"><button className="icon-button" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={historyIndex === 0 || !!busy} onClick={undo}><Icon name="undo"/></button><button className="icon-button" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={historyIndex === history.length - 1 || !!busy} onClick={redo}><Icon name="redo"/></button><span className="divider"/><button className="icon-button" aria-label="Zoom out" disabled={zoom <= 0.25} onClick={() => setZoom(value => Math.max(0.25, value - 0.1))}><Icon name="minus"/></button><select aria-label="Zoom level" value={String(Math.round(zoom * 100))} onChange={event => setZoom(Number(event.target.value) / 100)}>{[...new Set([25, 50, 75, 100, 125, 150, 200, Math.round(zoom * 100)])].sort((a, b) => a - b).map(value => <option key={value} value={value}>{value}%</option>)}</select><button className="icon-button" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + 0.1))}><Icon name="plus"/></button><button className="icon-button" aria-label="Fit to width" title="Fit to width" onClick={fit}><Icon name="expand"/></button></div>
        </div>
        <div className="document-tools" aria-label="PDF tools"><div><button disabled={!!busy} onClick={() => void addText()}>New text</button><button disabled={!!busy} onClick={() => chooseImage('image')}>Image</button><button disabled={!!busy} onClick={() => openTool('signature')}>Signature</button></div><div><button disabled={!!busy} onClick={() => openTool('merge')}>Merge PDFs</button><button disabled={!!busy} onClick={() => openTool('split')}>Split / extract</button></div></div>
        <div className="editor-layout">
          <aside className="pages-sidebar"><div className="sidebar-heading">Pages <span>{document.pages.length}</span></div><div className="page-list">{document.pages.map((model, index) => <button key={index} className={`page-thumbnail ${index === pageIndex ? 'current' : ''}`} aria-label={`Go to page ${index + 1}`} aria-current={index === pageIndex ? 'page' : undefined} onClick={() => navigate(index)}><div className="thumbnail-sheet" style={{ aspectRatio: `${model.width} / ${model.height}` }}><PdfCanvas proxy={activeProxy!} pageNumber={index + 1} scale={108 / model.width} thumbnail/><ObjectLayer objects={objects.filter(object => object.page === index)} selected={null} page={model} zoom={108 / model.width} editable={false} onSelect={selectObject} onChange={setObjectDraft} onCommit={commitObject}/></div><span className="thumbnail-number">{index + 1}{model.blocks.some(block => edits[block.id] !== undefined || boxes[block.id] || formats[block.id]) ? <span className="edited-dot"/> : null}</span></button>)}</div><div className="sidebar-footer"><Icon name="lock" size={13}/>Local workspace</div></aside>
          <main ref={workspace} className="workspace"><div className="workspace-hint"><span className="hint-tag">{mode === 'edit' ? 'EDIT MODE' : 'VIEW MODE'}</span>{mode === 'edit' ? 'Double-click text to select it and start editing.' : 'Your document, just as it will download.'}</div><div className="page-stage"><div className="pdf-page" style={{ width: page!.width * zoom, height: page!.height * zoom }}><PdfCanvas proxy={activeProxy!} pageNumber={pageIndex + 1} scale={zoom} onError={setError}/>{mode === 'edit' ? <div className="text-targets" onDoubleClick={doubleClickText}>{page!.blocks.map(block => <button key={block.id} type="button" className={`text-target ${selectedId === block.id ? 'active' : ''} ${edits[block.id] !== undefined ? 'edited' : ''}`} style={blockStyle(block)} aria-label={`Edit text: ${edits[block.id] ?? block.text}`} title="Double-click to select and edit this line" onClick={() => select(block)} onKeyDown={event => { if (event.key === "Enter" || event.key === "F2") { event.preventDefault(); select(block, true) } }}/>)}</div> : null}{mode === 'edit' && selected && inlineEditing ? <input ref={inlineInput} className="inline-text-input" onDoubleClick={event => { event.preventDefault(); event.currentTarget.select() }} aria-label="Edit selected text on page" value={draft} style={inlineStyle(selected)} onChange={event => { setDraft(event.target.value); setError('') }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyDraft() }; if (event.key === 'Escape') { discardDraft(); setInlineEditing(false) } }} spellCheck={false}/> : null}{mode === 'edit' && selectedGeometry ? <TextBoxControls geometry={selectedGeometry} style={geometryStyle(selectedGeometry)} zoom={zoom} disabled={!!busy} onResize={resizeSelected}/> : null}<ObjectLayer objects={objects.filter(object => object.page === pageIndex)} selected={objectDraft} page={page!} zoom={zoom} editable={mode === 'edit'} onSelect={selectObject} onChange={setObjectDraft} onCommit={commitObject}/></div></div><div className="page-navigation"><button className="icon-button previous" aria-label="Previous page" disabled={pageIndex === 0} onClick={() => navigate(pageIndex - 1)}><Icon name="chevron" size={15}/></button><span>Page <strong>{pageIndex + 1}</strong> of {document.pages.length}</span><button className="icon-button" aria-label="Next page" disabled={pageIndex === document.pages.length - 1} onClick={() => navigate(pageIndex + 1)}><Icon name="chevron" size={15}/></button></div></main>
          <aside className="properties-sidebar"><div className="sidebar-heading">{objectDraft && objectDraft.kind !== 'text' ? 'Object editor' : 'Text editor'} <span className="editor-symbol"><Icon name="text" size={15}/></span></div>{objectDraft ? <ObjectProperties key={objectDraft.id} object={objectDraft} pages={document.pages} dirty={objectChanged} onChange={setObjectDraft} onApply={() => applyDraft()} onDiscard={() => { setObjectDraft(objects.find(object => object.id === objectDraft.id) ?? null); setError('') }} onDelete={deleteObject} onClose={() => { if (!objectChanged || applyDraft()) setObjectDraft(null) }}/> : selected ? <div className="properties-content"><div className="selection-heading"><span className="eyebrow">SELECTED TEXT</span><button className="icon-button" aria-label="Close text editor" onClick={() => { if (!draftChanged || applyDraft()) setSelectedId(null) }}><Icon name="close" size={15}/></button></div><label className="field-label" htmlFor="text-value">Text content</label><textarea id="text-value" ref={textInput} aria-label="Text content" value={draft} onChange={event => { setDraft(event.target.value); setError('') }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); applyDraft() }; if (event.key === 'Escape') { discardDraft(); setSelectedId(null) } }} spellCheck={false}/><FormattingControls key={selected.id} format={activeFormat} onChange={updateFormat}/><div className="font-card"><span className="font-preview">Aa</span><div><span className="field-label">{draftFont?.substituted ? 'Compatible font' : 'Original font'}</span><strong>{draftFont?.name ?? selected.font}</strong><span>{(draftLayout?.fontSize ?? Math.hypot(selected.item.transform[2], selected.item.transform[3])).toFixed(1)} pt · {activeFormat.color}</span></div><Icon name="text" size={14}/></div>{draftFont?.substituted ? <p className="auto-fit-note" role="status">Original font unavailable for this edit. Using {draftFont.name} with matching weight and style.</p> : null}{!selected.native ? <p className="field-help">This page uses a complex text format. Saving preserves its appearance and adds editable text.</p> : null}{draftError ? <p className="field-error" role="status">{draftError}</p> : <p className="field-help">Drag the box handles to make room for longer text. Enter applies your edit.</p>}{draftLayout?.fitted ? <p className="auto-fit-note" role="status">Auto-fit: {draftLayout.fontSize.toFixed(1)} pt. Widen the box to use your chosen font size.</p> : null}<div className="box-dimensions"><span className="field-label">Text box size</span><div className="dimension-fields"><label>Width <PointInput key={`width-${selected.id}`} label="Text box width" value={selectedGeometry!.width} min={8} onChange={value => resizeSelected({ width: value, height: selectedGeometry!.height }, false)}/><span>pt</span></label><label>Height <PointInput key={`height-${selected.id}`} label="Text box height" value={selectedGeometry!.height} min={textGeometry(page!, selected).height} onChange={value => resizeSelected({ width: selectedGeometry!.width, height: value }, false)}/><span>pt</span></label></div><p className="field-help">Single line. More width keeps the original font size. Box edges stop at nearby text and page boundaries.</p></div><button className="button primary apply-button" disabled={!draftChanged || !!draftError || !!busy} onClick={() => applyDraft()}><Icon name="check" size={16}/>Apply edit</button><button className="text-button" disabled={!draftChanged} onClick={discardDraft}>Discard changes</button>{edits[selected.id] !== undefined || boxes[selected.id] || formats[selected.id] ? <button className="text-button restore-button" onClick={() => { const next = { ...edits }; delete next[selected.id]; const nextBoxes = { ...boxes }; delete nextBoxes[selected.id]; const nextFormats = { ...formats }; delete nextFormats[selected.id]; record(next, nextBoxes, nextFormats); setDraft(selected.text); setDraftBox(undefined); setDraftFormat(undefined) }}>Restore original text</button> : null}</div> : <div className="properties-empty"><div className="text-cursor-art"><Icon name="text" size={32}/><span className="cursor-arrow">↖</span></div><h3>{mode === 'edit' ? 'A word. A line. A fresh start.' : 'Take a closer look.'}</h3><p>{mode === 'edit' ? 'Double-click a line on your page to select its text and open the editor.' : 'Switch to Edit text to make changes to your document.'}</p><div className="mini-steps"><span>1</span>Double-click text on the page<span>2</span>Update your words<span>3</span>Apply and download</div></div>}<div className="properties-note"><Icon name="check" size={16}/><div><strong>Keep the original feel.</strong><p>Original font and colour, with automatic fitting to keep text inside its line.</p></div></div>{page!.blocks.length === 0 ? <div className="scan-note">No selectable text on this page. Scanned pages need OCR before their text can be edited.</div> : null}</aside>
        </div>
        <footer className="status-bar"><span><span className={`status-dot ${changedCount ? 'has-edits' : ''}`}/>{previewBusy ? 'Updating preview…' : changedCount ? `${changedCount} ${changedCount === 1 ? 'change' : 'changes'} applied` : 'Ready to edit'}</span><span>{page!.blocks.length} editable text lines on this page</span><span>PDF editing, a little simpler.</span></footer>
      </> : <main ref={workspace} className="welcome"><div className="welcome-content"><div className="welcome-badge"><span className="status-dot"/>YOUR DOCUMENT. YOUR WORDS.</div><h1>A fresh chapter<br/>for your <span>PDF.</span></h1><p className="welcome-description">Fix a typo. Update a detail. Make it yours.<br/>Edit existing text while keeping its original font.</p><button className={`upload-zone ${dragging ? 'dragging' : ''}`} disabled={!!busy} onClick={() => fileInput.current?.click()}><span className="upload-illustration"><Icon name="document" size={35}/><span><Icon name="plus" size={12}/></span></span><strong>Drop your PDF here</strong><span>or <b>browse files</b> to get started</span><small>PDF files · Processed on your device</small></button><button className="demo-button" disabled={!!busy} onClick={() => { setBusy('Creating sample…'); void createDemo().then(bytes => load(bytes, 'sample.pdf')).catch(() => { setBusy(''); setError('Could not create the sample PDF.') }) }}>Just exploring? <strong>Try a sample PDF <span>↗</span></strong></button><button className="button secondary welcome-merge" onClick={() => openTool('merge')}>Merge multiple PDFs</button><div className="welcome-features"><span><Icon name="text" size={16}/>Original fonts</span><span><Icon name="lock" size={15}/>100% local</span><span><Icon name="download" size={16}/>Ready to download</span></div></div><div className="welcome-footer">Made for the little edits that make a big difference.</div></main>}
      {dragging ? <div className="drop-overlay"><Icon name="upload" size={44}/><strong>Drop your PDF to open it</strong></div> : null}
      {busy ? <div className="loading-overlay" role="status"><span className="spinner"/><strong>{busy}</strong></div> : null}
      {tool === 'signature' ? <SignatureDialog errorMessage={error} onClose={() => setTool(null)} onUpload={() => chooseImage('signature')} onInsert={(data, width, height) => insertImage(data, width, height, 'signature', 'Drawn signature')}/> : null}
      {tool === 'merge' ? <MergeDialog errorMessage={error} current={document ? { id: 'current', name: fileName, pages: document.pages.length } : undefined} busy={!!busy} onClose={() => setTool(null)} onMerge={merge}/> : null}
      {tool === 'split' && document ? <SplitDialog errorMessage={error} count={document.pages.length} busy={!!busy} onClose={() => setTool(null)} onSplit={split}/> : null}
      {error || notice ? <div className={`toast ${error ? 'error' : 'success'}`} role={error ? 'alert' : 'status'}><span>{error || notice}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => { setError(''); setNotice('') }}><Icon name="close" size={16}/></button></div> : null}
    </div>
  )
}

export default App
