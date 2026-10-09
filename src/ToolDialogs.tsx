import { useEffect, useRef, useState } from 'react'
import type { PointerEvent, ReactNode } from 'react'
import { inspectMergeFile, parsePages } from './documentTools'
import type { MergeFile } from './documentTools'

function Dialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close() }, [])
  return <dialog ref={ref} className="tool-dialog" aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose() }}><header><h2>{title}</h2><button className="icon-button" aria-label={`Close ${title}`} disabled={busy} onClick={onClose}>×</button></header>{children}</dialog>
}

export function SignatureDialog({ onClose, onInsert, onUpload, errorMessage }: { errorMessage?: string; onClose: () => void; onInsert: (data: string, width: number, height: number) => void; onUpload: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const [hasInk, setHasInk] = useState(false)
  const [colour, setColour] = useState('#17284a')
  function point(event: PointerEvent<HTMLCanvasElement>): [number, number] {
    const rect = event.currentTarget.getBoundingClientRect()
    return [(event.clientX - rect.left) * event.currentTarget.width / rect.width, (event.clientY - rect.top) * event.currentTarget.height / rect.height]
  }
  function insert() {
    const source = canvas.current!, context = source.getContext('2d')!, pixels = context.getImageData(0, 0, source.width, source.height).data
    let left = source.width, right = 0, top = source.height, bottom = 0
    for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) if (pixels[(y * source.width + x) * 4 + 3]) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y) }
    if (left > right) return
    const cropped = document.createElement('canvas'); cropped.width = right - left + 13; cropped.height = bottom - top + 13
    cropped.getContext('2d')!.drawImage(source, left, top, right - left + 1, bottom - top + 1, 6, 6, right - left + 1, bottom - top + 1)
    onInsert(cropped.toDataURL('image/png'), cropped.width, cropped.height)
    cropped.width = cropped.height = 0
  }
  return <Dialog title="Add signature" onClose={onClose}><p className="dialog-help">Draw with your mouse, pen or finger. You can also upload a signature image.</p><canvas ref={canvas} width={1000} height={360} className="signature-pad" aria-label="Draw signature" onPointerDown={event => { event.preventDefault(); drawing.current = true; event.currentTarget.setPointerCapture(event.pointerId); const context = event.currentTarget.getContext('2d')!; context.strokeStyle = colour; context.fillStyle = colour; context.lineWidth = 4; context.lineCap = context.lineJoin = 'round'; const [x, y] = point(event); context.beginPath(); context.arc(x, y, 2, 0, Math.PI * 2); context.fill(); context.beginPath(); context.moveTo(x, y); setHasInk(true) }} onPointerMove={event => { if (!drawing.current) return; event.preventDefault(); const context = event.currentTarget.getContext('2d')!; context.lineTo(...point(event)); context.stroke() }} onPointerUp={() => { drawing.current = false }} onPointerCancel={() => { drawing.current = false }}/><div className="signature-options"><label>Ink <input type="color" aria-label="Signature ink colour" value={colour} onChange={event => setColour(event.target.value)}/></label><button className="button secondary" onClick={() => { canvas.current!.getContext('2d')!.clearRect(0, 0, 1000, 360); setHasInk(false) }}>Clear signature</button><button className="button secondary" onClick={onUpload}>Upload signature image</button></div><p className="dialog-help">This adds a visual signature to your PDF.</p>{errorMessage ? <p className="field-error" role="alert">{errorMessage}</p> : null}<footer><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={!hasInk} onClick={insert}>Insert signature</button></footer></Dialog>
}

export function MergeDialog({ current, busy, onClose, onMerge, errorMessage }: { errorMessage?: string; current?: MergeFile; busy: boolean; onClose: () => void; onMerge: (files: MergeFile[]) => Promise<void> }) {
  const [files, setFiles] = useState<MergeFile[]>(current ? [current] : [])
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  async function add(selected: File[]) {
    setReading(true); setError('')
    try {
      const added: MergeFile[] = []
      for (const file of selected) added.push(await inspectMergeFile(file))
      setFiles(previous => [...previous, ...added])
    } catch { setError('Could not read one of these PDFs. Choose valid, unlocked PDF files.') }
    finally { setReading(false) }
  }
  function reorder(index: number, direction: number) {
    setFiles(previous => { const next = [...previous]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; return next })
  }
  return <Dialog title="Merge PDFs" onClose={onClose} busy={busy || reading}><p className="dialog-help">Files will be joined in this order. Current edits, images and signatures are included.</p><input ref={input} type="file" accept="application/pdf,.pdf" multiple hidden aria-label="Choose PDFs to merge" onChange={event => { void add(Array.from(event.target.files ?? [])); event.target.value = '' }}/><div className="merge-files">{files.map((file, index) => <div className="merge-file" key={file.id}><span className="merge-index">{index + 1}</span><div><strong>{file.name}</strong><small>{file.pages} pages{!file.bytes ? ' · Current document' : ''}</small></div><button className="icon-button" aria-label={`Move ${file.name} up`} disabled={index === 0 || reading || busy} onClick={() => reorder(index, -1)}>↑</button><button className="icon-button" aria-label={`Move ${file.name} down`} disabled={index === files.length - 1 || reading || busy} onClick={() => reorder(index, 1)}>↓</button><button className="icon-button" aria-label={`Remove ${file.name}`} disabled={reading || busy} onClick={() => setFiles(previous => previous.filter(value => value.id !== file.id))}>×</button></div>)}</div><button className="button secondary" disabled={reading || busy} onClick={() => input.current?.click()}>{reading ? 'Reading PDFs...' : '+ Add PDFs'}</button>{error || errorMessage ? <p role="alert" className="field-error">{error || errorMessage}</p> : null}<footer><span className="dialog-help">{files.reduce((sum, file) => sum + file.pages, 0)} total pages</span><button className="button primary" disabled={files.length < 2 || reading || busy} onClick={() => void onMerge(files)}>Merge and open</button></footer></Dialog>
}

export function SplitDialog({ count, busy, onClose, onSplit, errorMessage }: { errorMessage?: string; count: number; busy: boolean; onClose: () => void; onSplit: (groups: number[][], zip: boolean) => Promise<void> }) {
  const [mode, setMode] = useState<'extract' | 'parts' | 'each'>('extract')
  const [range, setRange] = useState(`1-${count}`)
  let error = '', groups: number[][] = []
  try { groups = mode === 'each' ? Array.from({ length: count }, (_, index) => [index]) : (mode === 'parts' ? range.split(';') : [range]).map(value => parsePages(value, count)) } catch (cause) { error = cause instanceof Error ? cause.message : 'Check your page ranges.' }
  return <Dialog title="Split / extract PDF" onClose={onClose} busy={busy}><p className="dialog-help">Choose pages from this {count}-page document. Your current edits are included.</p><label className="dialog-label">Output<select aria-label="Split mode" value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="extract">Extract selected pages into one PDF</option><option value="parts">Split page ranges into separate PDFs (ZIP)</option><option value="each">Every page as a separate PDF (ZIP)</option></select></label>{mode !== 'each' ? <label className="dialog-label">{mode === 'parts' ? 'Page groups, separated by semicolons' : 'Pages and ranges'}<input aria-label="Page ranges" value={range} onChange={event => setRange(event.target.value)} placeholder={mode === 'parts' ? '1-2; 3-5; 6' : '1-3, 5'}/><small>{mode === 'parts' ? 'Example: 1-2; 3-5 creates two PDFs.' : 'Example: 1-3, 5. Enter 5, 1-3 to change page order.'}</small></label> : null}{error ? <p className="field-error" role="status">{error}</p> : <p className="dialog-help">{mode === 'extract' ? `${groups[0].length} pages selected` : `${groups.length} PDF files will be included in one ZIP download`}</p>}{errorMessage ? <p className="field-error" role="alert">{errorMessage}</p> : null}<footer><button className="button secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={!!error || busy} onClick={() => void onSplit(groups, mode !== 'extract')}>{mode === 'extract' ? 'Download extracted PDF' : 'Download split PDFs (ZIP)'}</button></footer></Dialog>
}
