import { useState } from 'react'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { ColumnMapper } from '@/components/upload/ColumnMapper'
import type { ColumnMapping, ParsedUpload } from '@/types'
import type { ImportMode } from '@/modules/config/useConfigTab'

interface RequiredField { name: string; label: string; required?: boolean }

interface Props {
  requiredFields: RequiredField[]
  onImport: (rows: Record<string, string>[], mappings: ColumnMapping[], mode: ImportMode) => void | Promise<void>
  importing?: boolean
  // 'merge' offered by default; set allowReplace=false to hide replace-all
  allowReplace?: boolean
  // Optional: add a new custom column inline during mapping
  onAddColumn?: (label: string) => void | Promise<void>
  // Optional explicit key for remembering the last mapping; defaults to the
  // set of field names so each import target keeps its own memory.
  storageKey?: string
}

// Single upload surface for config sections: file → mode choice → column map →
// direct import. "Replace all" warns before proceeding. Mapping isn't lost on
// re-open because the chosen file/mode stay until the user clicks Replace File.
export function ConfigUpload({ requiredFields, onImport, importing, allowReplace = true, onAddColumn, storageKey }: Props) {
  const [parsed, setParsed] = useState<ParsedUpload | null>(null)
  const [mode, setMode] = useState<ImportMode>('merge')
  // ColumnMapper owns mapping memory (local + org) under this key.
  const rememberKey = storageKey ?? requiredFields.map((f) => f.name).join('|')

  function handleConfirm(mappings: ColumnMapping[]) {
    if (!parsed) return
    if (mode === 'replace') {
      const ok = window.confirm(
        'Replace all: this DELETES every existing row in this section and replaces it with the uploaded file. This cannot be undone. Continue?'
      )
      if (!ok) return
    }
    onImport(parsed.rows, mappings, mode)
  }

  if (!parsed) {
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded border border-navy/20 bg-navy/5 px-4 py-3 flex flex-col gap-2">
          <p className="text-[10px] font-mono text-inky/60 uppercase tracking-widest">Expected columns in your file</p>
          <div className={['grid gap-x-8 gap-y-1', requiredFields.length > 4 ? 'grid-cols-2' : 'grid-cols-1'].join(' ')}>
            {requiredFields.map((f) => (
              <div key={f.name} className="flex items-center gap-1.5 min-w-0">
                <span className={[
                  'text-[10px] font-mono flex-shrink-0 rounded px-1 py-0.5 leading-tight',
                  f.required === true ? 'bg-navy/20 text-navy' : 'bg-inky/10 text-inky/50',
                ].join(' ')}>
                  {f.required === true ? 'REQ' : 'OPT'}
                </span>
                <span className="text-xs font-mono text-navy truncate">{f.label}</span>
              </div>
            ))}
          </div>
        </div>
        <FileUploadZone onParsed={(r) => setParsed(r)} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 border border-navy/30 rounded-lg p-4 bg-cream">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-inky uppercase tracking-wide">Mode</span>
          <div className="flex rounded border border-navy/30 overflow-hidden">
            <button onClick={() => setMode('merge')}
              className={['px-3 py-1 text-xs font-mono', mode === 'merge' ? 'bg-sky/20 text-navy font-bold' : 'text-inky hover:text-navy'].join(' ')}>
              Update changes only
            </button>
            {allowReplace && (
              <button onClick={() => setMode('replace')}
                className={['px-3 py-1 text-xs font-mono', mode === 'replace' ? 'bg-red-500/15 text-red-400' : 'text-inky hover:text-navy'].join(' ')}>
                Replace all
              </button>
            )}
          </div>
        </div>
        <button onClick={() => setParsed(null)} className="text-xs font-mono text-inky hover:text-navy">Replace file</button>
      </div>

      {mode === 'replace' && (
        <div className="text-xs font-mono text-red-400 border border-red-500/30 bg-red-500/5 rounded px-3 py-2">
          ⚠ Replace all wipes existing rows in this section before importing.
        </div>
      )}

      <ColumnMapper headers={parsed.headers} requiredFields={requiredFields} rememberKey={rememberKey} previewRows={parsed.rows.slice(0, 5)} onConfirm={handleConfirm} onCancel={() => setParsed(null)} onAddColumn={onAddColumn} />
      {importing && <p className="text-xs text-inky font-mono">Importing…</p>}
    </div>
  )
}
