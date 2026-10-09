import { useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { constrainObject, layoutAddedText, validateObject } from './documentTools'
import type { AddedObject } from './documentTools'
import type { PageModel } from './pdfEngine'
import { FormattingControls, PointInput } from './TextControls'

type ObjectCallbacks = { onSelect: (object: AddedObject) => boolean; onChange: (object: AddedObject) => void; onCommit: (object: AddedObject) => void }
export function ObjectLayer({ objects, selected, page, zoom, editable, onSelect, onChange, onCommit }: { objects: AddedObject[]; selected: AddedObject | null; page: PageModel; zoom: number; editable: boolean } & ObjectCallbacks) {
  const [editing, setEditing] = useState<string | null>(null)
  const drag = useRef<{ object: AddedObject; last: AddedObject; x: number; y: number; resize: boolean } | null>(null)
  function start(event: PointerEvent<HTMLDivElement | HTMLButtonElement>, object: AddedObject, resize = false) {
    if (!editable || !onSelect(object)) return
    event.preventDefault(); event.stopPropagation()
    setEditing(null)
    drag.current = { object, last: object, x: event.clientX, y: event.clientY, resize }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.focus()
  }
  function move(event: PointerEvent<HTMLDivElement | HTMLButtonElement>) {
    const current = drag.current
    if (!current) return
    const dx = (event.clientX - current.x) / zoom, dy = (event.clientY - current.y) / zoom
    let next = { ...current.object }
    if (current.resize) {
      if (next.kind === 'text') { next.width += dx; next.height += dy }
      else {
        const factor = Math.max(.05, Math.min(Math.max((next.width + dx) / next.width, (next.height + dy) / next.height), (page.width - next.x) / next.width, (page.height - next.y) / next.height))
        next.width *= factor; next.height *= factor
      }
    } else { next.x += dx; next.y += dy }
    next = constrainObject(next, page)
    current.last = next; onChange(next)
  }
  function end() { if (drag.current) { const last = drag.current.last; drag.current = null; onCommit(last) } }
  function cancel() { if (drag.current) { const original = drag.current.object; drag.current = null; onChange(original) } }
  return <div className={`objects-layer ${editable ? 'can-edit' : ''}`}>
    {objects.map(original => {
      const object = selected?.id === original.id ? selected : original
      const active = selected?.id === object.id && editable
      let layout: ReturnType<typeof layoutAddedText> | undefined
      if (object.kind === 'text') { try { layout = layoutAddedText(object) } catch { /* The properties panel explains invalid text. */ } }
      return <div key={object.id} className={`added-object ${active ? 'object-selected' : ''}`} style={{ left: object.x * zoom, top: object.y * zoom, width: object.width * zoom, height: object.height * zoom }} role={editable ? 'button' : undefined} tabIndex={editable ? 0 : undefined} aria-label={editable ? object.kind === 'text' ? 'Added text box' : `${object.kind === 'signature' ? 'Signature' : 'Image'}: ${object.label}` : undefined} aria-pressed={editable ? active : undefined} onPointerDown={event => start(event, object)} onPointerMove={move} onPointerUp={end} onPointerCancel={cancel} onLostPointerCapture={end} onDoubleClick={event => { event.stopPropagation(); if (editable && object.kind === 'text' && onSelect(object)) setEditing(object.id) }} onKeyDown={event => {
        if (!editable || event.target !== event.currentTarget) return
        if (event.key === 'Enter') { event.preventDefault(); if (onSelect(object) && object.kind === 'text') setEditing(object.id); return }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault(); if (!onSelect(object)) return
        const step = event.shiftKey ? 10 : 1
        onCommit(constrainObject({ ...object, x: object.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), y: object.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0) }, page))
      }}>
        {object.kind === 'text' ? <svg width="100%" height="100%" viewBox={`0 0 ${object.width} ${object.height}`} aria-hidden="true" style={{ overflow: 'hidden' }}>
          {(layout?.lines ?? [{ text: object.text, width: 0, baseline: 21 }]).map((line, index) => <g key={index} fill={object.format.color ?? '#000000'}>
            <text x="5" y={line.baseline} fontFamily={object.family === 'Times' ? 'Times New Roman, serif' : object.family === 'Courier' ? 'Courier New, monospace' : 'Arial, sans-serif'} fontSize={object.format.fontSize ?? 16} fontWeight={object.format.bold ? 'bold' : 'normal'} fontStyle={object.format.italic ? 'italic' : 'normal'} textLength={line.width || undefined} lengthAdjust="spacingAndGlyphs" xmlSpace="preserve">{line.text}</text>
            {[object.format.underline ? .13 : null, object.format.strike ? -.3 : null].map((offset, i) => offset === null ? null : <line key={i} x1="5" x2={5 + line.width} y1={line.baseline + (object.format.fontSize ?? 16) * offset} y2={line.baseline + (object.format.fontSize ?? 16) * offset} stroke={object.format.color ?? '#000000'} strokeWidth={Math.max(.4, (object.format.fontSize ?? 16) / 18)}/>)}
          </g>)}
        </svg> : <img src={object.data} alt={object.label} draggable={false}/>}
        {active && object.kind === 'text' && editing === object.id ? <textarea className="added-text-inline" aria-label="Edit added text on page" autoFocus value={object.text} style={{ fontSize: (object.format.fontSize ?? 16) * zoom, padding: 5 * zoom, fontFamily: object.family === 'Times' ? 'Times New Roman, serif' : object.family === 'Courier' ? 'Courier New, monospace' : 'Arial, sans-serif', fontWeight: object.format.bold ? 700 : 400, fontStyle: object.format.italic ? 'italic' : 'normal', color: object.format.color ?? '#000000' }} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onChange={event => onChange(constrainObject({ ...object, text: event.target.value }, page))} onBlur={() => setEditing(null)} onKeyDown={event => { if (event.key === 'Escape') setEditing(null); if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { onCommit(object); setEditing(null) } }}/>: null}
        {active ? <><span className="object-tag">{object.kind === 'text' ? 'TEXT' : object.kind.toUpperCase()} · Drag to move</span><button type="button" className="object-resize" aria-label="Resize added object" onPointerDown={event => start(event, object, true)} onPointerMove={event => { event.stopPropagation(); move(event) }} onPointerUp={event => { event.stopPropagation(); end() }} onPointerCancel={cancel} onLostPointerCapture={end} onKeyDown={event => {
          if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
          event.preventDefault(); event.stopPropagation()
          const step = event.shiftKey ? 10 : 1
          const width = object.width + (['ArrowRight', 'ArrowDown'].includes(event.key) ? step : -step)
          onCommit(constrainObject({ ...object, width, height: object.kind === 'text' ? object.height : object.height * width / object.width }, page))
        }}/></> : null}
      </div>
    })}
  </div>
}

export function ObjectProperties({ object, pages, dirty, onChange, onApply, onDiscard, onDelete, onClose }: { object: AddedObject; pages: PageModel[]; dirty: boolean; onChange: (object: AddedObject) => void; onApply: () => void; onDiscard: () => void; onDelete: () => void; onClose: () => void }) {
  const error = validateObject(object, pages)
  const update = (patch: Partial<AddedObject>) => onChange(constrainObject({ ...object, ...patch } as AddedObject, pages[object.page]))
  return <div className="properties-content object-properties"><div className="selection-heading"><span className="eyebrow">{object.kind === 'text' ? 'NEW TEXT BOX' : object.kind.toUpperCase()}</span><button className="icon-button" aria-label="Close object editor" onClick={onClose}>×</button></div>
    {object.kind === 'text' ? <><label className="field-label" htmlFor="added-text-value">Text content</label><textarea id="added-text-value" aria-label="New text content" value={object.text} onChange={event => update({ text: event.target.value })}/><label className="field-label object-font">Font family<select aria-label="New text font" value={object.family} onChange={event => update({ family: event.target.value as typeof object.family })}><option value="Helvetica">Arial / Helvetica</option><option value="Times">Times</option><option value="Courier">Courier</option></select></label><FormattingControls format={object.format} onChange={patch => update({ format: { ...object.format, ...patch } })}/></> : <><img className="object-preview" src={object.data} alt={object.label}/><p className="field-help">Drag to position. Resize from the corner; image proportions are preserved.</p></>}
    <div className="box-dimensions"><span className="field-label">Position and size · pt</span><div className="dimension-fields"><label>X<PointInput label="Object X" value={object.x} min={0} onChange={x => update({ x })}/></label><label>Y<PointInput label="Object Y" value={object.y} min={0} onChange={y => update({ y })}/></label></div><div className="dimension-fields"><label>Width<PointInput label="Object width" value={object.width} min={24} onChange={width => update({ width, ...(object.kind !== 'text' ? { height: object.height * width / object.width } : {}) })}/></label><label>Height<PointInput label="Object height" value={object.height} min={20} onChange={height => update({ height, ...(object.kind !== 'text' ? { width: object.width * height / object.height } : {}) })}/></label></div></div>
    {error ? <p className="field-error" role="status">{error}</p> : <p className="field-help">{object.kind === 'text' ? 'Text wraps automatically. Drag to move, double-click to type. Arrow keys move by 1 pt; Shift moves by 10 pt.' : 'Your image is embedded in the downloaded PDF.'}</p>}
    <button className="button primary apply-button" disabled={!dirty || !!error} onClick={onApply}>Apply object changes</button><button className="text-button" disabled={!dirty} onClick={onDiscard}>Discard object changes</button><button className="text-button delete-object" onClick={onDelete}>Delete {object.kind === 'text' ? 'text box' : object.kind}</button>
  </div>
}
