import { useState, useEffect, useRef } from 'react'
import { InverseToggle } from '@/components/shared/InverseToggle'
import { Button } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { TRANSFORM_CATALOG, describeTransform, type Transform, type TransformChainKind } from '@/lib/transforms'
import { CONSTANT_SOURCE, COMPOSITE_SOURCE, type ColumnMapping } from '@/types'

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
    <div className="flex flex-wrap items-center gap-1 pl-1 mt-1">
      <span className="text-[10px] font-mono text-inky/50">transforms:</span>
      {transforms.map((t, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded border border-navy/30 bg-cream px-1.5 py-0.5 text-[10px] font-mono text-navy">
          {describeTransform(t)}
          {(t.kind === 'multiply' || t.kind === 'divide') && (
            <input type="number" value={(t as any).by} onChange={(e) => update(i, { by: Number(e.target.value) })}
              className="w-12 border-b border-navy/30 bg-transparent text-[10px] text-inky focus:outline-none" />
          )}
          {(t.kind === 'parse_after' || t.kind === 'parse_before') && (
            <input value={(t as any).delimiter} onChange={(e) => update(i, { delimiter: e.target.value })}
              className="w-8 border-b border-navy/30 bg-transparent text-center text-[10px] text-inky focus:outline-none" />
          )}
          <button onClick={() => remove(i)} className="text-inky/70 hover:text-red-400">×</button>
        </span>
      ))}
      <select value="" onChange={(e) => { add(e.target.value); e.currentTarget.value = '' }}
        className="rounded border border-navy/30 bg-cream px-1 py-0.5 text-[10px] font-mono text-inky focus:outline-none">
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
  initialMappings?: ColumnMapping[]
  onAddColumn?: (label: string) => void | Promise<void>
  rememberKey?: string
  previewRows?: Record<string, string>[]
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
function loadSavedMap(key: string): ColumnMapping[] | undefined {
  try { const v = JSON.parse(localStorage.getItem(`import.map.${key}`) || 'null'); if (Array.isArray(v)) return v } catch { /* ignore */ }
  return undefined
}
function buildMappings(requiredFields: RequiredField[], headers: string[], saved?: ColumnMapping[]): ColumnMapping[] {
  return requiredFields.map((f) => {
    const fromTemplate = saved?.find(
      (m) => m.fieldName === f.name && (m.sourceColumn === CONSTANT_SOURCE || m.sourceColumn === COMPOSITE_SOURCE || headers.includes(m.sourceColumn))
    )
    if (fromTemplate) return { ...fromTemplate }
    const auto = headers.find((h) => norm(h) === norm(f.name))
    return { fieldName: f.name, sourceColumn: auto ?? '', invert: false }
  })
}

export function ColumnMapper({ headers, requiredFields, onConfirm, onCancel, initialMappings, onAddColumn, rememberKey, previewRows }: ColumnMapperProps) {
  const { profile } = useAuthStore()
  const localSaved = rememberKey ? loadSavedMap(rememberKey) : undefined
  const effectiveInitial = initialMappings ?? localSaved
  const [mappings, setMappings] = useState<ColumnMapping[]>(buildMappings(requiredFields, headers, effectiveInitial))
  const [newCol, setNewCol] = useState('')
  const touched = useRef(false)

  useEffect(() => {
    if (!rememberKey || initialMappings || localSaved || !profile?.company_id) return
    let cancelled = false
    ;(supabase as any).schema('platform').from('app_settings').select('value').eq('company_id', profile.company_id).eq('key', `mapping.${rememberKey}`).maybeSingle()
      .then(({ data }: any) => {
        if (cancelled || touched.current) return
        const org = data?.value
        if (Array.isArray(org) && org.length) setMappings(buildMappings(requiredFields, headers, org as ColumnMapping[]))
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rememberKey, profile?.company_id])

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
    touched.current = true
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
    if (rememberKey) {
      try { localStorage.setItem(`import.map.${rememberKey}`, JSON.stringify(mappings)) } catch { /* ignore */ }
      if (profile?.company_id) {
        void (supabase as any).schema('platform').from('app_settings').upsert(
          { company_id: profile.company_id, key: `mapping.${rememberKey}`, value: mappings, updated_at: new Date().toISOString() },
          { onConflict: 'company_id,key' },
        )
      }
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
      <p className="text-xs text-inky font-mono">
        Map each field to a file column, or pick <span className="text-navy">Constant value</span> to set the same value on every row.
        Use <span className="text-navy">transforms</span> to reshape values (e.g. strip currency symbols, multiply).
        <span className="text-navy"> Invert</span> flips the sign of numbers.
      </p>

      {previewRows && previewRows.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-mono uppercase tracking-wide text-inky">Preview ({previewRows.length} of file)</span>
          <div className="overflow-auto rounded border border-navy/30 max-h-40">
            <table className="text-[11px] font-mono">
              <thead className="bg-navy text-inky sticky top-0">
                <tr>{headers.map((h) => <th key={h} className="px-2 py-1 text-left whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody>
                {previewRows.map((r, i) => (
                  <tr key={i} className={i % 2 ? 'bg-white/[0.02]' : ''}>
                    {headers.map((h) => <td key={h} className="px-2 py-1 whitespace-nowrap text-navy">{r[h] ?? ''}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex flex-col">
        {requiredFields.map((field, rowIdx) => {
          const mapping = mappings.find((m) => m.fieldName === field.name)
          if (!mapping) return null
          const isConstant = mapping.sourceColumn === CONSTANT_SOURCE
          const isComposite = mapping.sourceColumn === COMPOSITE_SOURCE
          return (
            <div
              key={field.name}
              className={[
                'flex flex-col gap-0.5 px-2 py-2.5 border-b border-navy/10 last:border-0',
                rowIdx % 2 === 1 ? 'bg-navy/[0.02]' : '',
              ].join(' ')}
            >
              {/* Main row: label | source select | invert toggle */}
              <div className="grid grid-cols-[180px_1fr_auto] gap-3 items-center">
                <div className="text-sm font-mono text-navy flex items-center gap-1">
                  {field.label}
                  {field.required && <span className="text-red-400">*</span>}
                </div>
                <select
                  value={mapping.sourceColumn}
                  onChange={(e) => patch(field.name, { sourceColumn: e.target.value, constant: undefined, template: undefined })}
                  className="bg-cream border border-navy/30 rounded px-2 py-1.5 text-sm font-mono text-navy focus:outline-none focus:border-sky"
                >
                  <option value="">— Not mapped —</option>
                  <option value={CONSTANT_SOURCE}>✎ Constant value…</option>
                  <option value={COMPOSITE_SOURCE}>⊕ Composite (template)…</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
                <InverseToggle inverted={mapping.invert} onChange={(v) => patch(field.name, { invert: v })} />
              </div>

              {/* Constant value input + preview */}
              {isConstant && (
                <div className="pl-[192px] flex flex-col gap-0.5">
                  <input
                    value={mapping.constant ?? ''}
                    onChange={(e) => patch(field.name, { constant: e.target.value })}
                    placeholder="Value for all rows"
                    className="bg-cream border border-amber-400/40 rounded px-2 py-1 text-xs font-mono text-orange-600 focus:outline-none focus:border-amber-400"
                  />
                  {mapping.constant && (
                    <span className="text-[10px] font-mono text-orange-500">→ &quot;{mapping.constant}&quot; applied to every row</span>
                  )}
                </div>
              )}

              {/* Composite template input + token hints */}
              {isComposite && (
                <div className="pl-[192px] flex flex-col gap-0.5">
                  <input
                    value={mapping.template ?? ''}
                    onChange={(e) => patch(field.name, { template: e.target.value })}
                    placeholder="{location_code}-{city}"
                    title="Use {Header} tokens; literals are kept as-is"
                    className="bg-cream border border-sky/40 rounded px-2 py-1 text-xs font-mono text-inky focus:outline-none focus:border-sky"
                  />
                  <div className="text-[10px] font-mono text-inky/50">
                    Tokens: {headers.slice(0, 8).map((h) => `{${h}}`).join('  ')}{headers.length > 8 ? '  …' : ''}
                  </div>
                </div>
              )}

              {/* Transform chain — shown for regular column mappings */}
              {!isConstant && !isComposite && (
                <TransformChainEditor transforms={mapping.transforms} onChange={(t) => patch(field.name, { transforms: t })} />
              )}
            </div>
          )
        })}
      </div>

      {onAddColumn && (
        <div className="flex items-end gap-2 border-t border-navy/30 pt-3">
          <input
            value={newCol}
            onChange={(e) => setNewCol(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addColumn() }}
            placeholder="Add a new column (e.g. Area Manager)"
            className="flex-1 bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy focus:outline-none focus:border-sky"
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
