import { useEffect, useRef, useState } from 'react'
import type { TextFormat } from './pdfEngine'

export function PointInput({ label, value, min, max, onChange }: { label: string; value: number; min: number; max?: number; onChange: (value: number) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(String(Number(value.toFixed(1))))
  useEffect(() => { if (window.document.activeElement !== ref.current) setText(String(Number(value.toFixed(1)))) }, [value])
  return <input ref={ref} type="number" aria-label={label} value={text} min={min} max={max} step="1" onChange={event => {
    setText(event.target.value)
    if (Number.isFinite(event.target.valueAsNumber)) onChange(event.target.valueAsNumber)
  }} onBlur={() => setText(String(Number(value.toFixed(1))))} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }}/>
}

export function FormattingControls({ format, onChange }: { format: TextFormat; onChange: (patch: TextFormat, focusEditor?: boolean) => void }) {
  return <div className="formatting-controls"><span className="field-label">Text formatting</span><div className="format-toggles" role="group" aria-label="Text formatting">
    {([{ key: 'bold', label: 'Bold', symbol: 'B' }, { key: 'italic', label: 'Italic', symbol: 'I' }, { key: 'underline', label: 'Underline', symbol: 'U' }, { key: 'strike', label: 'Strikethrough', symbol: 'S' }] as const).map(item => <button key={item.key} type="button" className={`format-button format-${item.key} ${format[item.key] ? 'selected' : ''}`} aria-label={item.label} aria-pressed={!!format[item.key]} title={item.label} onMouseDown={event => event.preventDefault()} onClick={() => onChange({ [item.key]: !format[item.key] })}>{item.symbol}</button>)}
  </div><div className="format-fields"><label>Font size <span><PointInput label="Font size" value={format.fontSize ?? 12} min={1} max={300} onChange={value => onChange({ fontSize: value }, false)}/><small>pt</small></span></label><label>Text colour <input type="color" aria-label="Text colour" value={format.color ?? '#000000'} onChange={event => onChange({ color: event.target.value }, false)}/></label></div></div>
}

