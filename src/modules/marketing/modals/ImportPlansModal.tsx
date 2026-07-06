import { useEffect, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button, Badge } from '@/components/ui'
import toast from 'react-hot-toast'
import type { MarketingLocation } from '@/types/marketing'
import { MONTHS } from '@/types/marketing'

type MatchQuality = 'exact' | 'partial' | 'none'

interface ParsedRow {
  raw: string
  loc: MarketingLocation | null
  quality: MatchQuality
  include: boolean
  overrideLocId?: string | null  // undefined = use auto-match; null = force no match; string = manual pick
}

interface DetectedTask {
  name: string
  colIdx: number
  include: boolean
}

interface DetectedCampaign {
  name: string
  colStart: number
  colEnd: number
  tasks: DetectedTask[]
  include: boolean
  existingTemplateId: string | null
}

interface ExistingTemplate {
  id: string
  name: string
  category: string
  campaign_template_tasks?: { id: string; name: string; description: string | null; is_required: boolean; sort_order: number }[]
}

interface Props {
  locations: MarketingLocation[]
  filterMonth: number
  filterYear: number
  onClose: () => void
  onImported: () => void
}

const CURRENT_YEAR = new Date().getFullYear()

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

  const byCode = locations.find(l => l.name.toLowerCase() === tl)
  if (byCode) return { loc: byCode, quality: 'exact' }

  const byName = locations.find(l => l.name.toLowerCase() === tl || (l.shop_city ?? '').toLowerCase() === tl)
  if (byName) return { loc: byName, quality: 'exact' }

  const tn = norm(t)
  if (tn) {
    const byNorm = locations.find(l => norm(l.name) === tn || norm(l.shop_city ?? '') === tn)
    if (byNorm) return { loc: byNorm, quality: 'exact' }
  }

  const partial1 = locations.find(l => l.name.toLowerCase().includes(tl) || (l.shop_city ?? '').toLowerCase().includes(tl))
  if (partial1) return { loc: partial1, quality: 'partial' }

  const partial2 = locations.find(l => tl.includes(l.name.toLowerCase()) || (l.shop_city ? tl.includes(l.shop_city.toLowerCase()) : false))
  if (partial2) return { loc: partial2, quality: 'partial' }

  if (tn) {
    const partial3 = locations.find(l => {
      const ln = norm(l.name)
      const lc = norm(l.shop_city ?? '')
      return (ln && (ln.includes(tn) || tn.includes(ln))) || (lc && (lc.includes(tn) || tn.includes(lc)))
    })
    if (partial3) return { loc: partial3, quality: 'partial' }
  }

  return { loc: null, quality: 'none' }
}

function toRows(values: string[], locations: MarketingLocation[]): ParsedRow[] {
  const seen = new Set<string>()
  return values
    .filter(v => {
      const k = v.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .map(raw => {
      const { loc, quality } = matchLoc(raw, locations)
      return { raw, loc, quality, include: loc != null }
    })
}

function parsePaste(raw: string): string[] {
  return raw
    .split('\n')
    .map(line => line.split('\t')[0].trim())
    .filter(Boolean)
}

function colLabel(i: number): string {
  let s = ''
  let n = i
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return s
}

function detectCampaigns(
  sheet: XLSX.WorkSheet,
  locColIdx: number,
  existingTemplates: ExistingTemplate[],
): { campaigns: DetectedCampaign[]; locRows: string[] } {
  const merges: XLSX.Range[] = (sheet['!merges'] as XLSX.Range[] | undefined) ?? []
  const data = XLSX.utils.sheet_to_json<(string | number | undefined)[]>(sheet, { header: 1, defval: '' })

  // Find the row with the most merged cells among the first 4 rows — that's the campaign header row
  const mergesPerRow: Record<number, number> = {}
  for (const m of merges) mergesPerRow[m.s.r] = (mergesPerRow[m.s.r] ?? 0) + 1

  let headerRowIdx = 0
  let maxMerges = 0
  for (const [rowStr, count] of Object.entries(mergesPerRow)) {
    const r = Number(rowStr)
    if (r <= 3 && count > maxMerges) { maxMerges = count; headerRowIdx = r }
  }
  const taskRowIdx = headerRowIdx + 1

  const headerRow = (data[headerRowIdx] ?? []) as (string | number | undefined)[]
  const taskRow = (data[taskRowIdx] ?? []) as (string | number | undefined)[]

  const processedCols = new Set<number>()
  const campaigns: DetectedCampaign[] = []

  function resolveTemplate(name: string) {
    return existingTemplates.find(t => t.name.toLowerCase() === name.toLowerCase()) ?? null
  }

  // Merged cells in the header row → campaigns spanning multiple task columns
  for (const merge of merges.filter(m => m.s.r === headerRowIdx)) {
    const name = String(headerRow[merge.s.c] ?? '').trim()
    if (!name) continue

    const tasks: DetectedTask[] = []
    for (let c = merge.s.c; c <= merge.e.c; c++) {
      processedCols.add(c)
      if (c === locColIdx) continue
      const taskName = String(taskRow[c] ?? '').trim()
      if (taskName) tasks.push({ name: taskName, colIdx: c, include: true })
    }

    if (tasks.length > 0) {
      const tpl = resolveTemplate(name)
      campaigns.push({ name, colStart: merge.s.c, colEnd: merge.e.c, tasks, include: true, existingTemplateId: tpl?.id ?? null })
    }
  }

  // Non-merged header cells → single-task campaigns
  for (let c = 0; c < headerRow.length; c++) {
    if (processedCols.has(c) || c === locColIdx) continue
    const name = String(headerRow[c] ?? '').trim()
    if (!name) continue
    const taskName = String(taskRow[c] ?? '').trim()
    if (taskName) {
      processedCols.add(c)
      const tpl = resolveTemplate(name)
      campaigns.push({ name, colStart: c, colEnd: c, tasks: [{ name: taskName, colIdx: c, include: true }], include: true, existingTemplateId: tpl?.id ?? null })
    }
  }

  const locRows = (data as (string | number | undefined)[][])
    .slice(taskRowIdx + 1)
    .map(row => String(row[locColIdx] ?? '').trim())
    .filter(Boolean)

  return { campaigns, locRows }
}

export function ImportPlansModal({ locations, filterMonth, filterYear, onClose, onImported }: Props) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id
  const userId = profile?.id
  const sb = supabase as any
  const fileRef = useRef<HTMLInputElement>(null)

  const [inputMode, setInputMode] = useState<'paste' | 'file'>('file')
  const [pasteText, setPasteText] = useState('')
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null)
  const [fileName, setFileName] = useState('')
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [selectedSheet, setSelectedSheet] = useState('')
  const [colCount, setColCount] = useState(0)
  const [selectedCol, setSelectedCol] = useState(0)
  const [previewHeaders, setPreviewHeaders] = useState<string[]>([])

  const [rows, setRows] = useState<ParsedRow[]>([])
  const [editingOverrideIdx, setEditingOverrideIdx] = useState<number | null>(null)
  const [detectedCampaigns, setDetectedCampaigns] = useState<DetectedCampaign[]>([])
  const [existingTemplates, setExistingTemplates] = useState<ExistingTemplate[]>([])
  const [month, setMonth] = useState(filterMonth)
  const [year, setYear] = useState(filterYear)
  const [importing, setImporting] = useState(false)

  // For paste mode: keep template picker
  const [pasteTemplateIds, setPasteTemplateIds] = useState<string[]>([])

  useEffect(() => {
    sb.schema('marketing').from('campaign_templates')
      .select('id, name, category, campaign_template_tasks(id, name, description, is_required, sort_order)')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('sort_order')
      .then(({ data }: { data: ExistingTemplate[] | null }) => {
        const tpls = data ?? []
        setExistingTemplates(tpls)
        if (tpls.length) setPasteTemplateIds(tpls.map(t => t.id))
      })
  }, []) // eslint-disable-line

  function applySheet(wb: XLSX.WorkBook, sheetName: string, colIdx: number, tpls: ExistingTemplate[]) {
    const sheet = wb.Sheets[sheetName]
    if (!sheet) { setRows([]); setDetectedCampaigns([]); return }
    const data = XLSX.utils.sheet_to_json<(string | number | undefined)[]>(sheet, { header: 1, defval: '' })
    const maxCols = Math.max(...data.slice(0, 5).map(r => r.length), 1)
    setColCount(maxCols)
    const headerRow = data[0] ?? []
    setPreviewHeaders(Array.from({ length: maxCols }, (_, i) => String(headerRow[i] ?? '').trim()))

    const { campaigns, locRows } = detectCampaigns(sheet, colIdx, tpls)
    setDetectedCampaigns(campaigns)
    setRows(toRows(locRows, locations))
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = ev => {
      const ab = ev.target?.result as ArrayBuffer
      const wb = XLSX.read(ab, { type: 'array' })
      setWorkbook(wb)
      const names = wb.SheetNames
      setSheetNames(names)
      const defaultSheet = names.find(n => n === '2026') ?? names[0] ?? ''
      setSelectedSheet(defaultSheet)
      applySheet(wb, defaultSheet, 0, existingTemplates)
    }
    reader.readAsArrayBuffer(file)
  }

  function onSheetChange(name: string) {
    setSelectedSheet(name)
    setSelectedCol(0)
    if (workbook) applySheet(workbook, name, 0, existingTemplates)
  }

  function onColChange(idx: number) {
    setSelectedCol(idx)
    if (workbook && selectedSheet) applySheet(workbook, selectedSheet, idx, existingTemplates)
  }

  function handlePasteChange(text: string) {
    setPasteText(text)
    setRows(text.trim() ? toRows(parsePaste(text), locations) : [])
  }

  function getEffectiveLoc(row: ParsedRow) {
    if (row.overrideLocId !== undefined) {
      if (row.overrideLocId === null) return null
      return locations.find(l => l.id === row.overrideLocId) ?? null
    }
    return row.loc
  }

  function toggleRow(idx: number) {
    setRows(rs => rs.map((r, i) => i === idx ? { ...r, include: !r.include } : r))
  }

  function setRowOverride(idx: number, locId: string | null) {
    setRows(rs => rs.map((r, i) => {
      if (i !== idx) return r
      const newLoc = locId ? (locations.find(l => l.id === locId) ?? null) : null
      return { ...r, overrideLocId: locId, include: newLoc != null }
    }))
    setEditingOverrideIdx(null)
  }

  function toggleCampaign(idx: number) {
    setDetectedCampaigns(cs => cs.map((c, i) => i === idx ? { ...c, include: !c.include } : c))
  }

  function toggleTask(campaignIdx: number, taskIdx: number) {
    setDetectedCampaigns(cs => cs.map((c, ci) =>
      ci !== campaignIdx ? c : { ...c, tasks: c.tasks.map((t, ti) => ti === taskIdx ? { ...t, include: !t.include } : t) }
    ))
  }

  const includedRows = rows.filter(r => r.include && getEffectiveLoc(r))
  const includedCampaigns = inputMode === 'file'
    ? detectedCampaigns.filter(c => c.include)
    : existingTemplates.filter(t => pasteTemplateIds.includes(t.id))
  const unmatchedCount = rows.filter(r => !r.loc).length

  async function runImport() {
    if (includedRows.length === 0) { toast.error('No matched shops to import'); return }
    if (includedCampaigns.length === 0) { toast.error('No campaigns selected'); return }
    setImporting(true)

    // Build a template ID map: for file mode, upsert new templates as needed
    const campaignTemplateIds: string[] = []

    if (inputMode === 'file') {
      for (const campaign of includedCampaigns as DetectedCampaign[]) {
        if (campaign.existingTemplateId) {
          campaignTemplateIds.push(campaign.existingTemplateId)
          continue
        }

        // Create new template
        const { data: tpl, error: tplErr } = await sb.schema('marketing').from('campaign_templates')
          .insert({ company_id: companyId, name: campaign.name, category: 'General', is_active: true, sort_order: 0, created_by: userId })
          .select('id')
          .single()
        if (tplErr || !tpl) { toast.error(`Failed to create template: ${campaign.name}`); continue }

        // Create template tasks
        const taskPayloads = campaign.tasks
          .filter(t => t.include)
          .map((t, j) => ({ campaign_template_id: tpl.id, name: t.name, description: null, is_required: false, default_status: 'not_started', is_active: true, sort_order: j, created_by: userId }))
        if (taskPayloads.length) await sb.schema('marketing').from('campaign_template_tasks').insert(taskPayloads)

        // Reload this template so we have task IDs for assignment inserts
        const { data: fullTpl } = await sb.schema('marketing').from('campaign_templates')
          .select('id, name, category, campaign_template_tasks(id, name, description, is_required, sort_order)')
          .eq('id', tpl.id)
          .single()
        if (fullTpl) setExistingTemplates(prev => [...prev, fullTpl])
        campaignTemplateIds.push(tpl.id)
      }
    } else {
      campaignTemplateIds.push(...pasteTemplateIds)
    }

    // Reload templates to get full task details for new ones
    const { data: freshTpls } = await sb.schema('marketing').from('campaign_templates')
      .select('id, name, category, campaign_template_tasks(id, name, description, is_required, sort_order)')
      .in('id', campaignTemplateIds)
    const tplMap = new Map<string, ExistingTemplate>((freshTpls ?? []).map((t: ExistingTemplate) => [t.id, t]))

    let successCount = 0
    let skipCount = 0

    for (const row of includedRows) {
      const locId = getEffectiveLoc(row)!.id

      const { data: plan, error: planErr } = await sb.schema('marketing').from('monthly_plans')
        .upsert(
          { company_id: companyId, location_id: locId, plan_month: month, plan_year: year, created_by: userId, updated_by: userId, updated_at: new Date().toISOString() },
          { onConflict: 'company_id,location_id,plan_month,plan_year' }
        )
        .select('id')
        .single()
      if (planErr || !plan) { skipCount++; continue }

      const { data: existing } = await sb.schema('marketing').from('campaign_assignments')
        .select('campaign_template_id')
        .eq('monthly_plan_id', plan.id)
      const existingTplIds = new Set((existing ?? []).map((a: { campaign_template_id: string }) => a.campaign_template_id))

      for (let si = 0; si < campaignTemplateIds.length; si++) {
        const tplId = campaignTemplateIds[si]
        if (existingTplIds.has(tplId)) continue
        const tpl = tplMap.get(tplId)
        if (!tpl) continue

        const { data: assignment, error: aErr } = await sb.schema('marketing').from('campaign_assignments')
          .insert({ monthly_plan_id: plan.id, campaign_template_id: tplId, campaign_name_snapshot: tpl.name, campaign_category_snapshot: tpl.category, sort_order: si, created_by: userId })
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

  const hasRows = rows.length > 0
  const hasCampaigns = inputMode === 'file' ? detectedCampaigns.length > 0 : true

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 overflow-y-auto py-8">
      <div className="bg-cream dark:bg-[#0e2638] rounded-lg shadow-xl w-full max-w-2xl mx-4 flex flex-col gap-5 p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-heading font-bold text-navy">Import Plans</h2>
          <button onClick={onClose} className="text-inky/60 hover:text-navy text-xl">✕</button>
        </div>

        {/* Input mode toggle */}
        <div className="flex gap-2 text-xs font-mono">
          {(['file', 'paste'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => setInputMode(mode)}
              className={`px-3 py-1.5 rounded border transition-colors ${inputMode === mode ? 'bg-navy text-cream border-navy' : 'border-sky/30 text-inky/60 hover:text-navy'}`}
            >
              {mode === 'file' ? 'Upload Excel / CSV' : 'Paste from Excel'}
            </button>
          ))}
        </div>

        {/* File upload */}
        {inputMode === 'file' && (
          <div className="flex flex-col gap-3">
            <div
              className="border-2 border-dashed border-sky/30 rounded-lg p-6 text-center cursor-pointer hover:border-sky/60 transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              {fileName ? (
                <p className="text-xs font-mono text-navy">{fileName}</p>
              ) : (
                <>
                  <p className="text-xs font-mono text-navy font-bold mb-1">Click to choose file</p>
                  <p className="text-[11px] font-mono text-inky/50">Supports .xlsx, .xls — campaigns detected from merged header rows</p>
                </>
              )}
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.tsv,.txt" className="hidden" onChange={handleFile} />
            </div>

            {workbook && (
              <div className="flex gap-3 flex-wrap">
                {sheetNames.length > 1 && (
                  <div className="flex-1 min-w-[140px]">
                    <label className="text-xs font-mono text-inky/60 block mb-1">Sheet</label>
                    <select
                      className="w-full border border-sky/30 rounded px-2 py-1.5 text-xs font-mono bg-white dark:bg-[#122b40] text-navy"
                      value={selectedSheet}
                      onChange={e => onSheetChange(e.target.value)}
                    >
                      {sheetNames.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                )}
                {colCount > 1 && (
                  <div className="flex-1 min-w-[140px]">
                    <label className="text-xs font-mono text-inky/60 block mb-1">Shop name column</label>
                    <select
                      className="w-full border border-sky/30 rounded px-2 py-1.5 text-xs font-mono bg-white dark:bg-[#122b40] text-navy"
                      value={selectedCol}
                      onChange={e => onColChange(Number(e.target.value))}
                    >
                      {Array.from({ length: colCount }, (_, i) => (
                        <option key={i} value={i}>
                          {colLabel(i)}{previewHeaders[i] ? ` — ${previewHeaders[i]}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Paste */}
        {inputMode === 'paste' && (
          <div>
            <label className="text-xs font-mono text-inky/60 block mb-1">
              Paste shop names or codes (one per line, or copy a column from Excel)
            </label>
            <textarea
              className="w-full border border-sky/30 rounded px-3 py-2 text-xs font-mono bg-white dark:bg-[#122b40] text-navy placeholder:text-inky/40 focus:outline-none focus:ring-1 focus:ring-sky resize-y"
              rows={6}
              placeholder={"Houston - Westheimer\nDallas - Greenville\n..."}
              value={pasteText}
              onChange={e => handlePasteChange(e.target.value)}
            />
          </div>
        )}

        {/* Detected campaigns (file mode) */}
        {inputMode === 'file' && hasCampaigns && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-mono text-inky/60">
                Detected campaigns ({detectedCampaigns.filter(c => c.include).length} of {detectedCampaigns.length} selected)
              </label>
              <div className="flex gap-3 text-xs font-mono text-inky/50">
                <button onClick={() => setDetectedCampaigns(cs => cs.map(c => ({ ...c, include: true })))} className="hover:text-navy">All</button>
                <button onClick={() => setDetectedCampaigns(cs => cs.map(c => ({ ...c, include: false })))} className="hover:text-navy">None</button>
              </div>
            </div>
            {detectedCampaigns.length === 0 ? (
              <p className="text-xs font-mono text-inky/50 py-2">No campaigns detected. Try selecting a different sheet or column.</p>
            ) : (
              <div className="border border-sky/20 rounded max-h-52 overflow-y-auto bg-white dark:bg-[#122b40]">
                {detectedCampaigns.map((campaign, ci) => (
                  <div key={ci} className="border-b border-sky/10 last:border-0">
                    <label className="flex items-center gap-2 px-3 py-2 hover:bg-sky/10 cursor-pointer text-xs font-mono">
                      <input type="checkbox" checked={campaign.include} onChange={() => toggleCampaign(ci)} />
                      <span className="font-semibold text-navy flex-1">{campaign.name}</span>
                      {campaign.existingTemplateId
                        ? <Badge color="green">Existing template</Badge>
                        : <Badge color="orange">New template</Badge>
                      }
                      <span className="text-inky/40">{campaign.tasks.filter(t => t.include).length} tasks</span>
                    </label>
                    {campaign.include && campaign.tasks.length > 0 && (
                      <div className="pb-1.5">
                        {campaign.tasks.map((task, ti) => (
                          <label key={ti} className="flex items-center gap-2 px-6 py-0.5 hover:bg-sky/5 cursor-pointer text-xs font-mono text-inky/60">
                            <input type="checkbox" checked={task.include} onChange={() => toggleTask(ci, ti)} />
                            <span>{task.name}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Paste mode: template picker */}
        {inputMode === 'paste' && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-mono text-inky/60">Campaigns ({pasteTemplateIds.length} selected)</label>
              <div className="flex gap-3 text-xs font-mono text-inky/50">
                <button onClick={() => setPasteTemplateIds(existingTemplates.map(t => t.id))} className="hover:text-navy">All</button>
                <button onClick={() => setPasteTemplateIds([])} className="hover:text-navy">None</button>
              </div>
            </div>
            {existingTemplates.length === 0 ? (
              <div className="text-xs font-mono text-inky/60 py-2">No templates found. Create them in the Campaign Templates tab first.</div>
            ) : (
              <div className="border border-sky/20 rounded max-h-36 overflow-y-auto bg-white dark:bg-[#122b40]">
                {existingTemplates.map(tpl => (
                  <label key={tpl.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-sky/10 cursor-pointer text-xs font-mono">
                    <input type="checkbox" checked={pasteTemplateIds.includes(tpl.id)} onChange={() => setPasteTemplateIds(ids => ids.includes(tpl.id) ? ids.filter(i => i !== tpl.id) : [...ids, tpl.id])} />
                    <span className="text-navy">{tpl.name}</span>
                    <span className="text-inky/50">{tpl.category}</span>
                    <span className="text-inky/40">· {tpl.campaign_template_tasks?.length ?? 0} tasks</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Location match preview */}
        {hasRows && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-mono text-inky/60">
                {rows.filter(r => r.include).length} of {rows.length} shop{rows.length !== 1 ? 's' : ''} selected
                {unmatchedCount > 0 && <span className="ml-2 text-sb-orange">{unmatchedCount} unmatched</span>}
              </label>
              <div className="flex gap-3 text-xs font-mono text-inky/50">
                <button className="hover:text-navy" onClick={() => setRows(rs => rs.map(r => ({ ...r, include: getEffectiveLoc(r) != null })))}>All</button>
                <button className="hover:text-navy" onClick={() => setRows(rs => rs.map(r => ({ ...r, include: false })))}>None</button>
              </div>
            </div>
            <div className="border border-sky/20 rounded max-h-44 overflow-y-auto bg-white dark:bg-[#122b40]">
              {rows.map((row, i) => {
                const eff = getEffectiveLoc(row)
                const isOverridden = row.overrideLocId !== undefined
                const isEditing = editingOverrideIdx === i
                return (
                  <div key={i} className="border-b border-sky/10 last:border-0">
                    <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono">
                      <input type="checkbox" checked={row.include} disabled={!eff} onChange={() => toggleRow(i)} />
                      <span className={`flex-1 truncate ${eff ? 'text-navy' : 'text-inky/40 line-through'}`}>
                        {row.raw}
                      </span>
                      {eff ? (
                        <>
                          <span className="text-inky/40 flex-shrink-0">→</span>
                          <span className="text-navy truncate max-w-[140px]">{eff.shop_city ?? eff.name}</span>
                          <Badge color={isOverridden ? 'inky' : row.quality === 'exact' ? 'green' : 'orange'}>
                            {isOverridden ? 'Manual' : row.quality === 'exact' ? 'Exact' : 'Fuzzy'}
                          </Badge>
                        </>
                      ) : (
                        <Badge color="inky">No match</Badge>
                      )}
                      <button
                        className="text-inky/40 hover:text-navy shrink-0 px-1"
                        title="Override match"
                        onClick={() => setEditingOverrideIdx(isEditing ? null : i)}
                      >
                        ✎
                      </button>
                    </div>
                    {isEditing && (
                      <div className="flex items-center gap-2 px-3 pb-2">
                        <select
                          className="flex-1 border border-sky/30 rounded px-2 py-1 text-xs font-mono bg-white dark:bg-[#122b40] text-navy"
                          defaultValue={eff?.id ?? ''}
                          onChange={e => setRowOverride(i, e.target.value || null)}
                        >
                          <option value="">— No match —</option>
                          {[...locations]
                            .sort((a, b) => (a.shop_city ?? a.name).localeCompare(b.shop_city ?? b.name))
                            .map(l => (
                              <option key={l.id} value={l.id}>
                                {l.shop_city ?? l.name}{l.name ? ` (${l.name})` : ''}
                              </option>
                            ))}
                        </select>
                        <button className="text-xs font-mono text-inky/50 hover:text-navy" onClick={() => setEditingOverrideIdx(null)}>
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Month / year */}
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

        <div className="flex items-center justify-between">
          <p className="text-xs font-mono text-inky/50">
            {includedRows.length > 0 && includedCampaigns.length > 0
              ? `${includedRows.length} shop${includedRows.length !== 1 ? 's' : ''} × ${includedCampaigns.length} campaign${includedCampaigns.length !== 1 ? 's' : ''}`
              : 'Upload a file or paste shop names to begin'}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              size="sm"
              onClick={runImport}
              disabled={importing || includedRows.length === 0 || includedCampaigns.length === 0}
            >
              {importing ? 'Importing…' : `Import ${includedRows.length} Shop${includedRows.length !== 1 ? 's' : ''}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
