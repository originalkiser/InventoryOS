import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button, Badge } from '@/components/ui'
import toast from 'react-hot-toast'
import type { MarketingLocation, MarketingCampaignTemplate } from '@/types/marketing'
import { MONTHS } from '@/types/marketing'

type MatchQuality = 'exact' | 'partial' | 'none'

interface ParsedRow {
  raw: string
  loc: MarketingLocation | null
  quality: MatchQuality
  include: boolean
}

interface Props {
  locations: MarketingLocation[]
  filterMonth: number
  filterYear: number
  onClose: () => void
  onImported: () => void
}

const CURRENT_YEAR = new Date().getFullYear()

// Normalize a string for fuzzy matching
function norm(s: string) {
  return s.toLowerCase()
    .replace(/strickland\s*bros?\.?/gi, '')
    .replace(/oil\s*change/gi, '')
    .replace(/\bsb\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function matchLoc(text: string, locations: MarketingLocation[]): { loc: MarketingLocation | null; quality: MatchQuality } {
  const t = text.trim()
  if (!t) return { loc: null, quality: 'none' }
  const tl = t.toLowerCase()

  // Exact code match
  const byCode = locations.find(l => (l.location_code ?? '').toLowerCase() === tl)
  if (byCode) return { loc: byCode, quality: 'exact' }

  // Exact name match
  const byName = locations.find(l => l.name.toLowerCase() === tl)
  if (byName) return { loc: byName, quality: 'exact' }

  // Exact name after normalization
  const tn = norm(t)
  if (tn) {
    const byNorm = locations.find(l => norm(l.name) === tn)
    if (byNorm) return { loc: byNorm, quality: 'exact' }
  }

  // Partial: location name contains search text
  const partial1 = locations.find(l => l.name.toLowerCase().includes(tl))
  if (partial1) return { loc: partial1, quality: 'partial' }

  // Partial: search text contains location name
  const partial2 = locations.find(l => tl.includes(l.name.toLowerCase()))
  if (partial2) return { loc: partial2, quality: 'partial' }

  // Partial: normalized contains
  if (tn) {
    const partial3 = locations.find(l => {
      const ln = norm(l.name)
      return ln && (ln.includes(tn) || tn.includes(ln))
    })
    if (partial3) return { loc: partial3, quality: 'partial' }
  }

  return { loc: null, quality: 'none' }
}

function parseRaw(raw: string, locations: MarketingLocation[]): ParsedRow[] {
  const lines = raw.split('\n').map(line => {
    // First TSV/CSV column
    const col = line.split('\t')[0].split(',')[0].trim()
    return col
  }).filter(Boolean)

  // Deduplicate raw strings
  const seen = new Set<string>()
  const unique = lines.filter(l => {
    if (seen.has(l.toLowerCase())) return false
    seen.add(l.toLowerCase())
    return true
  })

  return unique.map(raw => {
    const { loc, quality } = matchLoc(raw, locations)
    return { raw, loc, quality, include: loc != null }
  })
}

function parseCSVText(text: string, locations: MarketingLocation[]): ParsedRow[] {
  // Detect delimiter
  const firstLine = text.split('\n')[0] ?? ''
  const isCSV = (firstLine.match(/,/g) ?? []).length > (firstLine.match(/\t/g) ?? []).length

  const lines = text.split('\n').map(line => {
    if (isCSV) {
      // Simple CSV parse: strip quotes from first field
      const field = line.split(',')[0].replace(/^"|"$/g, '').trim()
      return field
    }
    return line.split('\t')[0].trim()
  }).filter(Boolean)

  const seen = new Set<string>()
  const unique = lines.filter(l => {
    const k = l.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  return unique.map(raw => {
    const { loc, quality } = matchLoc(raw, locations)
    return { raw, loc, quality, include: loc != null }
  })
}

export function ImportPlansModal({ locations, filterMonth, filterYear, onClose, onImported }: Props) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id
  const userId = profile?.id
  const sb = supabase as any
  const fileRef = useRef<HTMLInputElement>(null)

  const [inputMode, setInputMode] = useState<'paste' | 'file'>('paste')
  const [pasteText, setPasteText] = useState('')
  const [rows, setRows] = useState<ParsedRow[]>([])
  const [templates, setTemplates] = useState<MarketingCampaignTemplate[]>([])
  const [loadingTemplates, setLoadingTemplates] = useState(true)
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>([])
  const [month, setMonth] = useState(filterMonth)
  const [year, setYear] = useState(filterYear)
  const [importing, setImporting] = useState(false)
  const [fileName, setFileName] = useState('')

  useEffect(() => {
    loadTemplates()
  }, []) // eslint-disable-line

  async function loadTemplates() {
    setLoadingTemplates(true)
    const { data } = await sb.schema('marketing').from('campaign_templates')
      .select('*, campaign_template_tasks(*)')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('sort_order')
    const tpls = data ?? []
    setTemplates(tpls)
    if (tpls.length) setSelectedTemplateIds(tpls.map((t: MarketingCampaignTemplate) => t.id))
    setLoadingTemplates(false)
  }

  function handlePasteChange(text: string) {
    setPasteText(text)
    if (text.trim()) {
      setRows(parseRaw(text, locations))
    } else {
      setRows([])
    }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = ev => {
      const text = (ev.target?.result as string) ?? ''
      setRows(parseCSVText(text, locations))
    }
    reader.readAsText(file)
  }

  function toggleRow(idx: number) {
    setRows(rs => rs.map((r, i) => i === idx ? { ...r, include: !r.include } : r))
  }

  function toggleTemplate(id: string) {
    setSelectedTemplateIds(ids => ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id])
  }

  const includedRows = rows.filter(r => r.include && r.loc)
  const unmatchedCount = rows.filter(r => !r.loc).length

  async function runImport() {
    if (includedRows.length === 0) { toast.error('No matched shops to import'); return }
    if (selectedTemplateIds.length === 0) { toast.error('Select at least one campaign'); return }
    setImporting(true)

    const chosenTemplates = templates.filter(t => selectedTemplateIds.includes(t.id))
    let successCount = 0
    let skipCount = 0

    for (let ri = 0; ri < includedRows.length; ri++) {
      const row = includedRows[ri]
      const locId = row.loc!.id

      // Upsert plan
      const { data: plan, error: planErr } = await sb.schema('marketing').from('monthly_plans')
        .upsert(
          { company_id: companyId, location_id: locId, plan_month: month, plan_year: year, created_by: userId, updated_by: userId, updated_at: new Date().toISOString() },
          { onConflict: 'company_id,location_id,plan_month,plan_year' }
        )
        .select('id')
        .single()
      if (planErr || !plan) { skipCount++; continue }

      // Get existing assignments to avoid duplicates
      const { data: existing } = await sb.schema('marketing').from('campaign_assignments')
        .select('campaign_template_id')
        .eq('monthly_plan_id', plan.id)
      const existingTplIds = new Set((existing ?? []).map((a: { campaign_template_id: string }) => a.campaign_template_id))

      for (let si = 0; si < chosenTemplates.length; si++) {
        const tpl = chosenTemplates[si]
        if (existingTplIds.has(tpl.id)) continue

        const { data: assignment, error: aErr } = await sb.schema('marketing').from('campaign_assignments')
          .insert({ monthly_plan_id: plan.id, campaign_template_id: tpl.id, campaign_name_snapshot: tpl.name, campaign_category_snapshot: tpl.category, sort_order: si, created_by: userId })
          .select('id')
          .single()
        if (aErr || !assignment) continue

        const tasks = (tpl.campaign_template_tasks ?? []).map((tt, j) => ({
          campaign_assignment_id: assignment.id,
          template_task_id: tt.id,
          task_name_snapshot: tt.name,
          task_description_snapshot: tt.description,
          status: 'not_started',
          is_required: tt.is_required,
          sort_order: j,
          created_by: userId,
        }))
        if (tasks.length) await sb.schema('marketing').from('campaign_tasks').insert(tasks)
      }
      successCount++
    }

    setImporting(false)
    if (successCount > 0) toast.success(`Imported ${successCount} shop${successCount !== 1 ? 's' : ''}`)
    if (skipCount > 0) toast.error(`${skipCount} shop(s) failed`)
    onImported()
  }

  const hasData = rows.length > 0

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 overflow-y-auto py-8">
      <div className="bg-cream dark:bg-[#0e2638] rounded-lg shadow-xl w-full max-w-2xl mx-4 flex flex-col gap-5 p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-heading font-bold text-navy">Import Plans</h2>
          <button onClick={onClose} className="text-inky/40 hover:text-navy dark:hover:text-cream text-xl">✕</button>
        </div>

        {/* Input mode toggle */}
        <div className="flex gap-2 text-xs font-mono">
          <button
            onClick={() => setInputMode('paste')}
            className={`px-3 py-1.5 rounded border transition-colors ${inputMode === 'paste' ? 'bg-navy text-cream border-navy' : 'border-sky/30 text-inky/60 hover:text-navy dark:hover:text-cream'}`}
          >
            Paste from Excel
          </button>
          <button
            onClick={() => setInputMode('file')}
            className={`px-3 py-1.5 rounded border transition-colors ${inputMode === 'file' ? 'bg-navy text-cream border-navy' : 'border-sky/30 text-inky/60 hover:text-navy dark:hover:text-cream'}`}
          >
            Upload CSV / TSV
          </button>
        </div>

        {/* Input area */}
        {inputMode === 'paste' ? (
          <div>
            <label className="text-xs font-mono text-inky/60 block mb-1">
              Paste shop names or codes (one per line, or copy a column from Excel)
            </label>
            <textarea
              className="w-full border border-sky/30 rounded px-3 py-2 text-xs font-mono bg-white dark:bg-[#122b40] text-navy placeholder:text-inky/40 focus:outline-none focus:ring-1 focus:ring-sky resize-y"
              rows={6}
              placeholder={"Houston - Westheimer\nDallas - Greenville\n12345\n..."}
              value={pasteText}
              onChange={e => handlePasteChange(e.target.value)}
            />
          </div>
        ) : (
          <div>
            <label className="text-xs font-mono text-inky/60 block mb-2">
              Upload a CSV or TSV file — first column should be the shop name or code
            </label>
            <div
              className="border-2 border-dashed border-sky/30 rounded-lg p-6 text-center cursor-pointer hover:border-sky/60 transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              {fileName ? (
                <p className="text-xs font-mono text-navy">{fileName}</p>
              ) : (
                <p className="text-xs font-mono text-inky/50">Click to choose file, or drag and drop</p>
              )}
              <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" className="hidden" onChange={handleFile} />
            </div>
          </div>
        )}

        {/* Preview table */}
        {hasData && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-mono text-inky/60">
                {rows.length} shop{rows.length !== 1 ? 's' : ''} parsed
                {unmatchedCount > 0 && <span className="ml-2 text-sb-orange">{unmatchedCount} unmatched</span>}
              </label>
              <div className="flex gap-3 text-xs font-mono text-inky/50">
                <button onClick={() => setRows(rs => rs.map(r => ({ ...r, include: r.loc != null })))} className="hover:text-navy dark:hover:text-cream">Reset</button>
                <button onClick={() => setRows(rs => rs.map(r => ({ ...r, include: r.loc != null })))} className="hover:text-navy dark:hover:text-cream">Matched only</button>
              </div>
            </div>
            <div className="border border-sky/20 rounded max-h-44 overflow-y-auto bg-white dark:bg-[#122b40]">
              {rows.map((row, i) => (
                <label key={i} className="flex items-center gap-2 px-3 py-1.5 hover:bg-sky/10 cursor-pointer text-xs font-mono border-b border-sky/10 last:border-0">
                  <input
                    type="checkbox"
                    checked={row.include}
                    disabled={!row.loc}
                    onChange={() => toggleRow(i)}
                  />
                  <span className={`flex-1 truncate ${row.loc ? 'text-navy' : 'text-inky/40 line-through'}`}>
                    {row.raw}
                  </span>
                  {row.loc ? (
                    <>
                      <span className="text-inky/40">→</span>
                      <span className="text-navy truncate max-w-[160px]">{row.loc.name}</span>
                      <Badge color={row.quality === 'exact' ? 'green' : 'orange'}>
                        {row.quality === 'exact' ? 'Exact' : 'Fuzzy'}
                      </Badge>
                    </>
                  ) : (
                    <Badge color="inky">No match</Badge>
                  )}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Month/year */}
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="text-xs font-mono text-inky/60 block mb-1">Month</label>
            <select
              className="w-full border border-sky/30 rounded px-3 py-2 text-sm font-mono bg-white dark:bg-[#122b40] text-navy"
              value={month} onChange={e => setMonth(Number(e.target.value))}
            >
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div className="w-28">
            <label className="text-xs font-mono text-inky/60 block mb-1">Year</label>
            <select
              className="w-full border border-sky/30 rounded px-3 py-2 text-sm font-mono bg-white dark:bg-[#122b40] text-navy"
              value={year} onChange={e => setYear(Number(e.target.value))}
            >
              {[CURRENT_YEAR - 1, CURRENT_YEAR, CURRENT_YEAR + 1].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>

        {/* Campaign selection */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-mono text-inky/60">Campaigns ({selectedTemplateIds.length} selected)</label>
            <div className="flex gap-3 text-xs font-mono text-inky/50">
              <button onClick={() => setSelectedTemplateIds(templates.map(t => t.id))} className="hover:text-navy dark:hover:text-cream">All</button>
              <button onClick={() => setSelectedTemplateIds([])} className="hover:text-navy dark:hover:text-cream">None</button>
            </div>
          </div>
          {loadingTemplates ? (
            <div className="text-xs font-mono text-inky/60 py-2">Loading templates…</div>
          ) : templates.length === 0 ? (
            <div className="text-xs font-mono text-inky/60 py-2">No templates found.</div>
          ) : (
            <div className="border border-sky/20 rounded max-h-36 overflow-y-auto bg-white dark:bg-[#122b40]">
              {templates.map(tpl => (
                <label key={tpl.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-sky/10 cursor-pointer text-xs font-mono">
                  <input type="checkbox" checked={selectedTemplateIds.includes(tpl.id)} onChange={() => toggleTemplate(tpl.id)} />
                  <span className="text-navy">{tpl.name}</span>
                  <span className="text-inky/50">{tpl.category}</span>
                  <span className="text-inky/40">· {tpl.campaign_template_tasks?.length ?? 0} tasks</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between">
          <p className="text-xs font-mono text-inky/50">
            {includedRows.length > 0
              ? `Will create/update plans for ${includedRows.length} shop${includedRows.length !== 1 ? 's' : ''}`
              : 'Paste or upload shop names to begin'}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              size="sm"
              onClick={runImport}
              disabled={importing || includedRows.length === 0 || selectedTemplateIds.length === 0}
            >
              {importing ? 'Importing…' : `Import ${includedRows.length} Shop${includedRows.length !== 1 ? 's' : ''}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
