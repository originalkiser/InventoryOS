import { useEffect, useState } from 'react'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { ColumnMapper } from '@/components/upload/ColumnMapper'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { Button, Input, Select, Combobox, Card, CardBody } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useLocations } from '@/hooks/useLocations'
import { SUMMARY_FIELDS, toNumber, locationOptions, type SummaryUploadTarget } from './countsShared'
import type { Location, ColumnMapping, ParsedUpload, CountMappingTemplate } from '@/types'
import toast from 'react-hot-toast'

type Mode = 'file' | 'live' | 'manual'
type ImportMode = 'additive' | 'replace' | 'update'

interface Props {
  locations: Location[]
  companyId: string
  target: SummaryUploadTarget
  uploadedBy: string | null
  onImported: () => void
}

const NUMERIC = SUMMARY_FIELDS.filter((f) => f.numeric).map((f) => f.name)

export function CountSummaryUpload({ locations, companyId, target, onImported }: Props) {
  const loc = useLocations()
  const [mode, setMode] = useState<Mode>('file')
  const [importMode, setImportMode] = useState<ImportMode>('additive')
  const [parsed, setParsed] = useState<ParsedUpload | null>(null)
  const [importing, setImporting] = useState(false)

  // Saved templates for this module
  const [templates, setTemplates] = useState<CountMappingTemplate[]>([])
  const [templateId, setTemplateId] = useState('')
  // After import, offer to save the mapping just used
  const [savedMappings, setSavedMappings] = useState<ColumnMapping[] | null>(null)
  const [templateName, setTemplateName] = useState('')

  useEffect(() => { loadTemplates() }, [companyId, target.templateModule])

  async function loadTemplates() {
    const { data } = await (supabase as any)
      .from('count_mapping_templates')
      .select('*')
      .eq('company_id', companyId)
      .eq('module', target.templateModule)
      .order('created_at', { ascending: false })
    const list = (data ?? []) as CountMappingTemplate[]
    setTemplates(list)
    if (list.length && !templateId) setTemplateId(list[0].id)
  }

  const activeTemplate = templates.find((t) => t.id === templateId)

  async function importRows(mappings: ColumnMapping[]) {
    if (!parsed) return
    setImporting(true)
    const batchId = crypto.randomUUID()
    const locCol = mappings.find((m) => m.fieldName === 'location')?.sourceColumn
    const dateCol = mappings.find((m) => m.fieldName === 'count_date')?.sourceColumn
    let unresolved = 0

    const rows = parsed.rows.map((row) => {
      const out: Record<string, unknown> = {
        company_id: companyId,
        upload_batch_id: batchId,
        ...target.buildExtraColumns(),
      }
      // Location — POS-map + numeric aware resolution.
      const locId = locCol ? loc.resolveId(row[locCol] ?? '') : null
      if (!locId && locCol && (row[locCol] ?? '').trim()) unresolved++
      out.location_id = locId
      // Count date (schema: not null) — default to period start if unmapped/invalid
      let countDate = target.defaultCountDateISO
      if (dateCol && row[dateCol]) {
        const d = new Date(row[dateCol])
        if (!isNaN(d.getTime())) countDate = d.toISOString()
      }
      out.count_date = countDate
      // Remaining mapped fields
      for (const m of mappings) {
        if (m.fieldName === 'location' || m.fieldName === 'count_date') continue
        const raw = row[m.sourceColumn] ?? ''
        if (NUMERIC.includes(m.fieldName)) {
          const num = toNumber(raw)
          out[m.fieldName] = num === null ? null : m.invert ? -num : num
        } else {
          out[m.fieldName] = raw || null
        }
      }
      return out
    })

    const sb = supabase as any
    // Replace = wipe this period's rows; Update = wipe only the uploaded
    // locations' rows for the period; Additive = just append.
    if (importMode === 'replace' || importMode === 'update') {
      const extra = target.buildExtraColumns()
      let del = sb.from(target.table).delete().eq('company_id', companyId)
      for (const [k, v] of Object.entries(extra)) if (k !== 'uploaded_at') del = del.eq(k, v)
      const locIds = [...new Set(rows.map((r) => r.location_id).filter(Boolean))] as string[]
      if (importMode === 'update') {
        if (locIds.length) del = del.in('location_id', locIds)
        else del = null
      }
      if (del) { const { error: delErr } = await del; if (delErr) { setImporting(false); toast.error(delErr.message); return } }
    }

    const { error } = await sb.from(target.table).insert(rows)
    setImporting(false)
    if (error) {
      toast.error(error.message)
      return
    }
    toast.success(`Imported ${rows.length} summary rows${unresolved ? ` · ${unresolved} unresolved locations` : ''}`)
    setSavedMappings(mappings)
    setTemplateName('')
    setParsed(null)
    onImported()
  }

  async function saveTemplate() {
    if (!savedMappings || !templateName.trim()) return
    const { error } = await (supabase as any).from('count_mapping_templates').insert({
      company_id: companyId,
      module: target.templateModule,
      name: templateName.trim(),
      mappings: savedMappings,
    })
    if (error) toast.error(error.message)
    else {
      toast.success('Mapping template saved')
      setSavedMappings(null)
      loadTemplates()
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-xs font-mono text-inky uppercase tracking-wide">{target.cardLabel}</span>
          <ModeSwitch mode={mode} onChange={(m) => { setMode(m); setParsed(null); setSavedMappings(null) }} />
        </div>

        {mode === 'file' && (
          <>
            {!parsed ? (
              <div className="flex flex-col gap-3">
                <div className="rounded border border-navy/20 bg-navy/5 px-4 py-3 flex flex-col gap-2">
                  <p className="text-[10px] font-mono text-inky/60 uppercase tracking-widest">Expected columns in your file</p>
                  <div className="grid grid-cols-2 gap-x-8 gap-y-1">
                    {SUMMARY_FIELDS.map((f) => (
                      <div key={f.name} className="flex items-center gap-1.5 min-w-0">
                        <span className={['text-[10px] font-mono flex-shrink-0 rounded px-1 py-0.5 leading-tight', f.required === true ? 'bg-navy/20 text-navy' : 'bg-inky/10 text-inky/50'].join(' ')}>
                          {f.required === true ? 'REQ' : 'OPT'}
                        </span>
                        <span className="text-xs font-mono text-navy truncate">{f.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <FileUploadZone onParsed={(r) => setParsed(r)} />
              </div>
            ) : (
              <>
                {templates.length > 0 && (
                  <div className="w-64">
                    <Select
                      label="Apply Saved Template"
                      options={[{ value: '', label: '— Auto-detect columns —' }, ...templates.map((t) => ({ value: t.id, label: t.name }))]}
                      value={templateId}
                      onChange={(e) => setTemplateId(e.target.value)}
                    />
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-inky uppercase tracking-wide">On import</span>
                  <div className="flex rounded border border-navy/30 overflow-hidden">
                    {([['additive', 'Additive'], ['update', 'Update changes'], ['replace', 'Replace all']] as [ImportMode, string][]).map(([v, l]) => (
                      <button key={v} onClick={() => setImportMode(v)}
                        className={['px-3 py-1 text-xs font-mono', importMode === v ? (v === 'replace' ? 'bg-red-500/15 text-red-400' : 'bg-[#00e5ff]/10 text-inky') : 'text-inky hover:text-navy'].join(' ')}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
                <ColumnMapper
                  key={templateId || 'auto'}
                  headers={parsed.headers}
                  requiredFields={SUMMARY_FIELDS}
                  initialMappings={activeTemplate?.mappings as ColumnMapping[] | undefined}
                  rememberKey={`monthend.summary.${target.templateModule}`}
                  previewRows={parsed.rows.slice(0, 5)}
                  onConfirm={importRows}
                  onCancel={() => setParsed(null)}
                />
                {importing && <p className="text-xs text-inky font-mono">Importing…</p>}
              </>
            )}

            {savedMappings && (
              <div className="flex items-end gap-2 p-3 border border-[#39ff14]/30 bg-[#39ff14]/5 rounded">
                <div className="flex-1">
                  <Input
                    label="Save mapping as template"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder={target.templatePlaceholder}
                  />
                </div>
                <Button size="sm" onClick={saveTemplate} disabled={!templateName.trim()}>Save</Button>
                <Button size="sm" variant="secondary" onClick={() => setSavedMappings(null)}>Dismiss</Button>
              </div>
            )}
          </>
        )}

        {mode === 'live' && <DataSourceLinker configType={target.dataSourceConfigType} />}

        {mode === 'manual' && (
          <ManualSummaryForm
            locations={locations}
            companyId={companyId}
            target={target}
            onSaved={onImported}
          />
        )}
      </CardBody>
    </Card>
  )
}

function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const opts: { value: Mode; label: string }[] = [
    { value: 'file', label: 'File' },
    { value: 'live', label: 'Live Source' },
    { value: 'manual', label: 'Manual' },
  ]
  return (
    <div className="flex rounded border border-navy/30 overflow-hidden">
      {opts.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={[
            'px-3 py-1 text-xs font-mono transition-colors',
            mode === o.value ? 'bg-[#00e5ff]/10 text-inky' : 'text-inky hover:text-navy',
          ].join(' ')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function ManualSummaryForm({
  locations, companyId, target, onSaved,
}: { locations: Location[]; companyId: string; target: SummaryUploadTarget; onSaved: () => void }) {
  const [locationId, setLocationId] = useState('')
  const [countType, setCountType] = useState('')
  const [totalAdj, setTotalAdj] = useState('')
  const [adjValue, setAdjValue] = useState('')
  const [absAdjValue, setAbsAdjValue] = useState('')
  const [endingCost, setEndingCost] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!locationId) { toast.error('Location is required'); return }
    if (!endingCost.trim()) { toast.error('Ending inventory cost is required'); return }
    setSaving(true)
    const { error } = await (supabase as any).from(target.table).insert({
      company_id: companyId,
      location_id: locationId,
      count_date: target.defaultCountDateISO,
      count_type: countType || null,
      total_adjustments: toNumber(totalAdj),
      adjustment_value: toNumber(adjValue),
      abs_adjustment_value: toNumber(absAdjValue),
      ending_inventory_cost: toNumber(endingCost),
      upload_batch_id: crypto.randomUUID(),
      ...target.buildExtraColumns(),
    })
    setSaving(false)
    if (error) toast.error(error.message)
    else {
      toast.success('Count saved')
      setLocationId(''); setCountType(''); setTotalAdj(''); setAdjValue(''); setAbsAdjValue(''); setEndingCost('')
      onSaved()
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Combobox
        label="Location *"
        options={locationOptions(locations)}
        value={locationId}
        onChange={(v) => setLocationId(v)}
        placeholder="Select location"
      />
      <div className="grid grid-cols-2 gap-3">
        <Input label="Count Type" value={countType} onChange={(e) => setCountType(e.target.value)} />
        <Input label="Total Adjustments" value={totalAdj} onChange={(e) => setTotalAdj(e.target.value)} />
        <Input label="Adjustment Value" value={adjValue} onChange={(e) => setAdjValue(e.target.value)} />
        <Input label="Abs Adjustment Value" value={absAdjValue} onChange={(e) => setAbsAdjValue(e.target.value)} />
      </div>
      <Input label="Ending Inventory Cost *" value={endingCost} onChange={(e) => setEndingCost(e.target.value)} />
      <div className="flex justify-end">
        <Button size="sm" loading={saving} onClick={save}>Add Count</Button>
      </div>
    </div>
  )
}
