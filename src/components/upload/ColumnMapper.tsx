import { useState, useEffect } from 'react'
import { InverseToggle } from '@/components/shared/InverseToggle'
import { Button } from '@/components/ui'
import { TRANSFORM_OPTIONS } from '@/lib/columnTransform'
import { TRANSFORM_CATALOG, describeTransform, type Transform, type TransformChainKind } from '@/lib/transforms'
import { CONSTANT_SOURCE, COMPOSITE_SOURCE, type ColumnMapping, type TransformKind } from '@/types'

function defaultTransform(kind: TransformChainKind): Transform {
  switch (kind) {
    case 'multiply': return { kind: 'multiply', by: 1 }
    case 'divide': return { kind: 'divide', by: 1 }
    case 'parse_after': return { kind: 'parse_after', delimiter: '#' }
    case 'parse_before': return { kind: 'parse_before', delimiter: '-' }
    default: return { kind } as Transform
  }
}

function TransformChainEditor({ transforms = [], onChange }: { transforms?: Transform[]; onChange: (t: Transform[]) => void }) {
  function add(kind: string) { if (kind) onChange([...transforms, defaultTransform(kind as TransformChainKind)]) }
  function update(i: number, patch: any) { onChange(transforms.map((t, j) => (j === i ? { ...t, ...patch } : t))) }
  function remove(i: number) { onChange(transforms.filter((_, j) => j !== i)) }
  return (
    <div className="flex flex-wrap items-center gap-1 pl-1">
      <span className="text-[10px] font-mono text-gray-600">transforms:</span>
      {transforms.map((t, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded border border-[#2a2d3e] bg-[#0f1117] px-1.5 py-0.5 text-[10px] font-mono text-gray-300">
          {describeTransform(t)}
          {(t.kind === 'multiply' || t.kind === 'divide') && (
            <input type="number" value={(t as any).by} onChange={(e) => update(i, { by: Number(e.target.value) })}
              className="w-12 border-b border-[#2a2d3e] bg-transparent text-[10px] text-[#00e5ff] focus:outline-none" />
          )}
          {(t.kind === 'parse_after' || t.kind === 'parse_before') && (
            <input value={(t as any).delimiter} onChange={(e) => update(i, { delimiter: e.target.value })}
              className="w-8 border-b border-[#2a2d3e] bg-transparent text-center text-[10px] text-[#00e5ff] focus:outline-none" />
          )}
          <button onClick={() => remove(i)} className="text-gray-600 hover:text-red-400">×</button>
        </span>
      ))}
      <select value="" onChange={(e) => { add(e.target.value); e.currentTarget.value = '' }}
        className="rounded border border-[#2a2d3e] bg-[#0f1117] px-1 py-0.5 text-[10px] font-mono text-gray-400 focus:outline-none">
        <option value="">+ transform</option>
        {TRANSFORM_CATALOG.map((c) => <option key={c.kind} value={c.kind}>{c.label}</option>)}
      </select>
    </div>
  )
}

interface RequiredField {
  name: string
  label: string
  required?: boolean
}

interface ColumnMapperProps {
  headers: string[]
  requiredFields: RequiredField[]
  onConfirm: (mappings: ColumnMapping[]) => void
  onCancel?: () => void
  // Optional saved-template mappings; pre-fill any whose sourceColumn exists in the file.
  initialMappings?: ColumnMapping[]
  // Optional: allow adding a brand-new (custom) column inline during mapping.
  onAddColumn?: (label: string) => void | Promise<void>
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export function ColumnMapper({ headers, requiredFields, onConfirm, onCancel, initialMappings, onAddColumn }: ColumnMapperProps) {
  const [mappings, setMappings] = useState<ColumnMapping[]>(
    requiredFields.map((f) => {
      const fromTemplate = initialMappings?.find(
        (m) => m.fieldName === f.name && (m.sourceColumn === CONSTANT_SOURCE || m.sourceColumn === COMPOSITE_SOURCE || headers.includes(m.sourceColumn))
      )
      if (fromTemplate) return { ...fromTemplate }
      const auto = headers.find((h) => norm(h) === norm(f.name))
      return { fieldName: f.name, sourceColumn: auto ?? '', invert: false }
    })
  )
  const [newCol, setNewCol] = useState('')

  // Sync newly-added required fields (e.g. a column added inline) into state
  // without disturbing existing selections.
  useEffect(() => {
    setMappings((prev) => {
      const have = new Set(prev.map((m) => m.fieldName))
      const additions = requiredFields
        .filter((f) => !have.has(f.name))
        .map((f) => {
          const auto = headers.find((h) => norm(h) === norm(f.name))
          return { fieldName: f.name, sourceColumn: auto ?? '', invert: false }
        })
      return additions.length ? [...prev, ...additions] : prev
    })
  }, [requiredFields, headers])

  function patch(fieldName: string, p: Partial<ColumnMapping>) {
    setMappings((prev) => prev.map((m) => (m.fieldName === fieldName ? { ...m, ...p } : m)))
  }

  function handleConfirm() {
    const missing = requiredFields
      .filter((f) => f.required)
      .filter((f) => !mappings.find((m) => m.fieldName === f.name)?.sourceColumn)
    if (missing.length > 0) {
      alert(`Please map required fields: ${missing.map((f) => f.label).join(', ')}`)
      return
    }
    onConfirm(mappings.filter((m) => m.sourceColumn))
  }

  async function addColumn() {
    const label = newCol.trim()
    if (!label || !onAddColumn) return
    await onAddColumn(label)
    setNewCol('')
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-gray-400 font-mono">
        Map each field to a file column, or pick <span className="text-white">Constant value</span> to set the same value
        on every row. <span className="text-white">Convert</span> transforms the value (e.g. <span className="text-[#00e5ff]">Number</span> turns &quot;001&quot; into 1);
        <span className="text-white"> Invert</span> flips the sign of numbers.
      </p>
      <div className="flex flex-col gap-3">
        {requiredFields.map((field) => {
          const mapping = mappings.find((m) => m.fieldName === field.name)!
          const isConstant = mapping.sourceColumn === CONSTANT_SOURCE
          const isComposite = mapping.sourceColumn === COMPOSITE_SOURCE
          return (
            <div key={field.name} className="flex flex-col gap-1">
            <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-3 items-center">
              <div className="text-sm font-mono text-gray-300">
                {field.label}
                {field.required && <span className="text-red-400 ml-1">*</span>}
              </div>
              <select
                value={mapping.sourceColumn}
                onChange={(e) => patch(field.name, { sourceColumn: e.target.value })}
                className="bg-[#0f1117] border border-[#2a2d3e] rounded px-2 py-1.5 text-sm font-mono text-white focus:outline-none focus:border-[#00e5ff]"
              >
                <option value="">— Not mapped —</option>
                <option value={CONSTANT_SOURCE}>✎ Constant value…</option>
                <option value={COMPOSITE_SOURCE}>⊕ Composite (template)…</option>
                {headers.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
              {isConstant ? (
                <input
                  value={mapping.constant ?? ''}
                  onChange={(e) => patch(field.name, { constant: e.target.value })}
                  placeholder="Value for all rows"
                  className="bg-[#0f1117] border border-[#ffb300]/40 rounded px-2 py-1.5 text-xs font-mono text-[#ffb300] focus:outline-none focus:border-[#ffb300]"
                />
              ) : isComposite ? (
                <input
                  value={mapping.template ?? ''}
                  onChange={(e) => patch(field.name, { template: e.target.value })}
                  placeholder="{location_code}-{city}"
                  title="Use {Header} tokens; literals are kept as-is"
                  className="bg-[#0f1117] border border-[#00e5ff]/40 rounded px-2 py-1.5 text-xs font-mono text-[#00e5ff] focus:outline-none focus:border-[#00e5ff]"
                />
              ) : (
                <select
                  value={mapping.transform ?? 'none'}
                  onChange={(e) => patch(field.name, { transform: e.target.value as TransformKind })}
                  title="Convert value on import"
                  className="bg-[#0f1117] border border-[#2a2d3e] rounded px-2 py-1.5 text-xs font-mono text-gray-300 focus:outline-none focus:border-[#00e5ff]"
                >
                  {TRANSFORM_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              )}
              <InverseToggle inverted={mapping.invert} onChange={(v) => patch(field.name, { invert: v })} />
            </div>
            {isComposite ? (
              <div className="pl-1 text-[10px] font-mono text-gray-600">Tokens: {headers.slice(0, 8).map((h) => `{${h}}`).join('  ')}{headers.length > 8 ? '  …' : ''}</div>
            ) : !isConstant ? (
              <TransformChainEditor transforms={mapping.transforms} onChange={(t) => patch(field.name, { transforms: t })} />
            ) : null}
            </div>
          )
        })}
      </div>

      {onAddColumn && (
        <div className="flex items-end gap-2 border-t border-[#2a2d3e] pt-3">
          <input
            value={newCol}
            onChange={(e) => setNewCol(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addColumn() }}
            placeholder="Add a new column (e.g. Area Manager)"
            className="flex-1 bg-[#0f1117] border border-[#2a2d3e] rounded px-2 py-1.5 text-xs font-mono text-white focus:outline-none focus:border-[#00e5ff]"
          />
          <Button size="sm" variant="secondary" onClick={addColumn} disabled={!newCol.trim()}>+ Add Column</Button>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        {onCancel && (
          <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
        )}
        <Button size="sm" onClick={handleConfirm}>Confirm Mapping</Button>
      </div>
    </div>
  )
}
